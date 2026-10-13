import { resolve } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { OVERRIDES_FILE, PINS_FILE } from "./choice-rules.js";
import { choiceDigest, type SkillChoice, type SkillOverride } from "./choices.js";
import { readChoiceFile } from "./project-pins.js";
import { parseSkillKey, removeSkillPin, skillLockPath } from "./lock.js";
import { discoverSkills, pinBuiltinSkills, pinSkill, unreleasedSources, type DiscoverOptions } from "./registry.js";
import { releaseProblemText } from "./release.js";
import { SKILL_DIGEST_RE } from "./schema.js";
import { readSources, SOURCES_FILE } from "./sources.js";

export const SKILLS_USAGE = `usage: scf skills [--repo <dir>]                              List skills, their trust and pin state, and problems
       scf skills pin <id@version> <sha256:digest> [--replace]   Approve the listed package (copy the digest from the list)
       scf skills pin --builtin                                  Pin the built-in skills that have no pin
       scf skills unpin <id@version>                             Remove a pin
       scf skills sources check [<file>]                         Check a skill source list (default: ${SOURCES_FILE})
       scf skills overrides check [<file>]                       Check the owner overrides (default: ${OVERRIDES_FILE})
       scf skills project-pins check [<file>]                    Check the project pins (default: ${PINS_FILE})
       scf skills import <source-id> [<file>]                    Fetch the approved commit of a source into quarantine
       scf skills discover [<export-file> [<file>]]              Propose sources from a saved Skills.sh export (never approves)`;

const ALLOWED: Record<string, string[]> = { list: ["repo"], pin: ["repo", "replace", "builtin"], unpin: ["repo"], sources: [], overrides: [], "project-pins": [] };

export interface SkillsCommandOptions extends DiscoverOptions {
  skills?: Config["skills"];
  /** Where a relative source file is looked for (default: the current folder). */
  cwd?: string;
  /** The time entries are checked against (default: now). For tests. */
  now?: Date;
}

/** `scf skills overrides check` and `scf skills project-pins check`: offline; prints checked fields and the entry digest only. */
function choicesCheck(file: string, kind: "overrides" | "project-pins", out: (line: string) => void, now: Date): number {
  const r = kind === "overrides" ? readChoiceFile(file, "overrides") : readChoiceFile(file, "project-pins");
  if (r.state === "none") {
    out(`PROBLEM the ${kind === "overrides" ? "owner overrides" : "project pins"} file does not exist`);
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  let expired = 0;
  for (const e of r.items as (SkillChoice | SkillOverride)[]) {
    const scope = "scope" in e ? (e.scope === "all" ? "all" : e.scope.repositories.join(",")) : "repository";
    const end = e.expires !== undefined ? `expires ${e.expires}` : `review ${e.review_by}`;
    const isExpired = e.expires !== undefined && Date.parse(e.expires) <= now.getTime();
    const due = e.review_by !== undefined && Date.parse(e.review_by) <= now.getTime();
    if (isExpired) expired++;
    out(`${e.capability} ${e.target} ${e.by} ${scope} ${e.from} → ${end} ${choiceDigest(e)}${isExpired ? " EXPIRED" : due ? " REVIEW DUE" : ""}`);
  }
  out(`OK ${r.items.length} entries`);
  return expired ? 1 : 0;
}

/** `scf skills sources check`: offline, prints checked fields only. */
function sourcesCheck(file: string, out: (line: string) => void): number {
  const r = readSources(file);
  if (r.state === "none") {
    out("PROBLEM the skill source file does not exist");
    return 1;
  }
  if (r.state === "invalid") {
    for (const p of r.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  let enabled = 0;
  for (const s of r.manifest.sources) {
    if (s.status === "enabled") enabled++;
    const head = `${s.id.padEnd(24)} ${s.status} ${s.trust} ${s.adapter} ${s.repositoryKey}@${(s.ref.approved ?? "-").slice(0, 12)} ${s.owner}`;
    out(s.reason ? `${head} (${s.reason})` : head);
  }
  out(`OK ${r.manifest.sources.length} sources, ${enabled} enabled`);
  return 0;
}

const syntax = (why: string) => new Error(`${why}\n${SKILLS_USAGE}`);

/** `scf skills …`. `values` holds the options that were given; the syntax is checked before any read or write. */
export async function skillsCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillsCommandOptions = {},
): Promise<number> {
  const first = args.positionals[0];
  const sub = first === undefined ? "list" : first;
  const operands = first === undefined ? [] : args.positionals.slice(1);
  if (!Object.hasOwn(ALLOWED, sub)) throw syntax(`scf skills: unknown sub-command ${sub}`);
  const allowed = ALLOWED[sub]!;
  for (const [k, v] of Object.entries(args.values)) {
    if (v !== undefined && !allowed.includes(k)) throw syntax(`scf skills${sub === "list" ? "" : " " + sub}: unexpected option --${k}`);
  }
  const builtin = args.values.builtin === true;
  const replace = args.values.replace === true;
  if (sub === "list" && args.positionals.length) throw syntax("scf skills: unexpected operand");
  if (sub === "pin") {
    if (builtin) {
      if (replace) throw syntax("scf skills pin: --builtin cannot be used with --replace");
      if (operands.length) throw syntax("scf skills pin --builtin: takes no operands");
    } else {
      if (operands.length !== 2) throw syntax("scf skills pin: expects a skill (id@version) and a digest");
      if (!parseSkillKey(operands[0]!)) throw syntax(`scf skills pin: ${operands[0]} is not a skill key (id@version)`);
      if (!SKILL_DIGEST_RE.test(operands[1]!)) throw syntax("scf skills pin: the digest must be sha256: and 64 hex digits");
    }
  }
  if (sub === "unpin") {
    if (operands.length !== 1) throw syntax("scf skills unpin: expects one skill (id@version)");
    if (!parseSkillKey(operands[0]!)) throw syntax(`scf skills unpin: ${operands[0]} is not a skill key (id@version)`);
  }
  if (sub === "sources") {
    if (operands[0] !== "check" || operands.length > 2) throw syntax('scf skills sources: expects "check" and at most one file');
    return sourcesCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? SOURCES_FILE), out);
  }

  if (sub === "overrides" || sub === "project-pins") {
    if (operands[0] !== "check" || operands.length > 2) throw syntax(`scf skills ${sub}: expects "check" and at most one file`);
    const dflt = sub === "overrides" ? OVERRIDES_FILE : PINS_FILE;
    return choicesCheck(resolve(opts.cwd ?? process.cwd(), operands[1] ?? dflt), sub, out, opts.now ?? new Date());
  }

  const { skills, cwd: _cwd, now: _now, ...discover } = opts;
  if (sub === "unpin") {
    const key = operands[0]!;
    if (removeSkillPin(key)) {
      out(`Unpinned ${key}`);
      return 0;
    }
    out(`${key} is not pinned`);
    return 1;
  }

  const reg = discoverSkills(skills ?? loadConfig().skills, discover);
  if (sub === "pin") {
    if (builtin) {
      const r = pinBuiltinSkills(reg);
      if (r.pinned.length) out(`Pinned ${r.pinned.join(", ")}`);
      for (const key of r.mismatched) {
        out(`PROBLEM ${key} does not match its pin and was not changed. Run "scf skills" to see both digests, check the package, then run "scf skills pin ${key} <digest> --replace".`);
      }
      if (!r.pinned.length && !r.mismatched.length) out("Nothing to pin");
      return r.mismatched.length ? 1 : 0;
    }
    const key = operands[0]!;
    const r = pinSkill(reg, key, operands[1]!, { replace });
    out(r === "pinned" ? `Pinned ${key}` : r === "unchanged" ? `Already pinned ${key}` : `Replaced the pin of ${key}`);
    return 0;
  }

  for (const s of reg.skills) {
    out(`${s.id.padEnd(24)} ${s.version}  [${s.label}] ${s.trust} ${s.pin} ${s.digest}${s.active ? "" : ` (shadowed by ${s.shadowedBy})`}`);
  }
  for (const r of reg.sources) {
    const rel = r.release;
    if (rel && rel.state !== "none" && rel.state !== "invalid") out(`RELEASE ${r.label} ${rel.catalogue}@${rel.version} ${rel.digest} ${rel.state}`);
  }
  for (const r of unreleasedSources(reg)) {
    out(`NOTE ${r.label} is loaded without an approved release (${releaseProblemText(r.release)}): skills.releases.allow_unreleased is on (development only).`);
  }
  for (const n of reg.notes) out(`NOTE ${n.text}`);
  const lockPath = skillLockPath(discover.home ?? dataHome());
  for (const p of reg.problems) {
    const root = p.kind === "lock" ? lockPath : (reg.sources.find((r) => r.label === p.label)?.root ?? p.root);
    out(`PROBLEM ${p.label} ${root}${p.package && p.kind !== "integrity" ? "/" + p.package : ""}: ${p.reason}`);
  }
  return reg.problems.length ? 1 : 0;
}
