import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { SkillPackage } from "./schema.js";

export const code = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
export const cut = (s: string) => (s.length > 300 ? s.slice(0, 299) + "…" : s);

export function packageBytes(p: SkillPackage): number {
  let n = p.instructions.length;
  for (const list of Object.values(p.files)) for (const f of list) n += f.content.byteLength;
  return n;
}

const PERSONAL = new Set([".claude", ".codex"]);

const inside = (p: string, base: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The personal agent folders: the defaults and the ones the environment names, as written and as resolved. */
function personalRoots(env: NodeJS.ProcessEnv, userHome: string): string[] {
  const list = [join(userHome, ".claude"), join(userHome, ".codex")];
  if (env.CLAUDE_CONFIG_DIR) list.push(resolve(env.CLAUDE_CONFIG_DIR));
  if (env.CODEX_HOME) list.push(resolve(env.CODEX_HOME));
  return [...new Set(list.flatMap((p) => [p, real(p)].filter((x): x is string => !!x)))];
}

/** True for a path in a personal Claude or Codex folder: a `.claude`/`.codex` segment, or inside CLAUDE_CONFIG_DIR, CODEX_HOME or the default folders. Lexical, and also on the resolved path when it exists. */
export function personalAgentPath(p: string, env: NodeJS.ProcessEnv = process.env, userHome = homedir()): boolean {
  const abs = resolve(p);
  const forms = [abs, real(abs)].filter((x): x is string => !!x);
  const roots = personalRoots(env, userHome);
  return forms.some((f) => f.split(/[\\/]/).some((s) => PERSONAL.has(s)) || roots.some((r) => inside(f, r)));
}
