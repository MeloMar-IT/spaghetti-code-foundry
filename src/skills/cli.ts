import { loadConfig, type Config } from "../config.js";
import { dataHome } from "../auth/store.js";
import { parseSkillKey, removeSkillPin, skillLockPath } from "./lock.js";
import { discoverSkills, pinBuiltinSkills, pinSkill, type DiscoverOptions } from "./registry.js";
import { SKILL_DIGEST_RE } from "./schema.js";

export const SKILLS_USAGE = `usage: scf skills [--repo <dir>]                              List skills, their trust and pin state, and problems
       scf skills pin <id@version> <sha256:digest> [--replace]   Approve the listed package (copy the digest from the list)
       scf skills pin --builtin                                  Pin the built-in skills that have no pin
       scf skills unpin <id@version>                             Remove a pin`;

const ALLOWED: Record<string, string[]> = { list: ["repo"], pin: ["repo", "replace", "builtin"], unpin: ["repo"] };

export interface SkillsCommandOptions extends DiscoverOptions {
  skills?: Config["skills"];
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

  const { skills, ...discover } = opts;
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
  for (const n of reg.notes) out(`NOTE ${n.text}`);
  const lockPath = skillLockPath(discover.home ?? dataHome());
  for (const p of reg.problems) {
    const root = p.kind === "lock" ? lockPath : (reg.sources.find((r) => r.label === p.label)?.root ?? p.root);
    out(`PROBLEM ${p.label} ${root}${p.package && p.kind !== "integrity" ? "/" + p.package : ""}: ${p.reason}`);
  }
  return reg.problems.length ? 1 : 0;
}
