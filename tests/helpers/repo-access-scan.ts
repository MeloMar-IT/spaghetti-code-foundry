import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** `gh` as a command: not part of a word, a path or a variable, and followed by a subcommand. */
export const GH_RE = /(?<![\w$./-])gh(?:[ \t]|\\\r?\n)+[a-z]/;
/** git with a subcommand that talks to the remote. */
export const GIT_REMOTE_RE = /\bgit\b[^\n;|&]*?[ \t](?:clone|fetch|pull|push|ls-remote)\b/;
const VARIABLE_RE = /(?:FACTORY|SCF)_VAR_(?:TEST|BUILD|LINT)_CMD\b|\{\{\s*vars\.(?:test|build|lint)_cmd\s*\}\}|(?:FACTORY|SCF)_TOOLS\}?\/detect-commands\b/;
// The commands tools/detect-commands prints for each kind of project.
const COMMAND_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)[ \t]+(?:ci|install|test|run[ \t]+(?:build|lint|test))\b`,
    String.raw`\bgo[ \t]+(?:test|build|vet)\b`,
    String.raw`\bcargo[ \t]+(?:test|build|clippy)\b`,
    String.raw`\bpytest\b|\bpython3?[ \t]+-m[ \t]+pytest\b|\bruff[ \t]+check\b`,
    String.raw`\./?gradlew[ \t]+(?:test|check|build)\b|\bgradle[ \t]+(?:test|check|build)\b`,
    String.raw`\bmvn\b[^\n;|&]*?\b(?:test|verify|package)\b`,
    String.raw`\bbundle[ \t]+exec[ \t]+rspec\b`,
    String.raw`\bmake[ \t]+(?:test|build|lint)\b`,
  ].join("|"),
);

/** Names of the files in tools/ that call gh or the remote, sorted. */
export function remoteTools(root = "."): string[] {
  const names: string[] = [];
  for (const d of readdirSync(join(root, "tools"), { withFileTypes: true }).filter((e) => e.isFile())) {
    const source = readFileSync(join(root, "tools", d.name), "utf8");
    let hit: boolean;
    if (/^#!.*\bnode\b/.test(source)) {
      hit = /["']gh["']/.test(source) || /["'](?:clone|fetch|pull|push|ls-remote)["']/.test(source);
    } else {
      const code = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      hit = GH_RE.test(code) || GIT_REMOTE_RE.test(code);
    }
    if (hit) names.push(d.name);
  }
  return names.sort();
}

/** Does the command call gh, the remote with git, or one of `tools`? */
export function usesRepo(run: string, tools: readonly string[]): boolean {
  if (GH_RE.test(run) || GIT_REMOTE_RE.test(run)) return true;
  for (const m of run.matchAll(/(?:FACTORY|SCF)_TOOLS\}?\/([\w-]+)/g)) if (tools.includes(m[1]!)) return true;
  return false;
}

/** Does the command run the project's test, lint or build command? */
export function runsTestsOrBuild(run: string): boolean {
  return VARIABLE_RE.test(run) || COMMAND_RE.test(run);
}

export interface AccessHit { where: string; problem: string }

/** Problems of the shell steps of one flow. */
export function scanSteps(
  flow: string,
  steps: { id: string; type?: string; run?: unknown; repo_access?: unknown }[],
  tools: readonly string[],
): AccessHit[] {
  const hits: AccessHit[] = [];
  for (const s of steps) {
    if (s.type !== "shell" || typeof s.run !== "string") continue;
    const where = `${flow}/${s.id}`;
    const uses = usesRepo(s.run, tools);
    if (uses && s.repo_access !== true) hits.push({ where, problem: "calls gh or the remote without repo_access" });
    if (s.repo_access === true && runsTestsOrBuild(s.run)) hits.push({ where, problem: "has repo_access and runs the test or build command" });
    if (s.repo_access === true && !uses) hits.push({ where, problem: "has repo_access but does not call gh or the remote" });
  }
  return hits;
}

/** scanSteps for every flows/*.yaml under root. */
export function scanRepoAccess(root = "."): AccessHit[] {
  const tools = remoteTools(root);
  const hits: AccessHit[] = [];
  for (const f of readdirSync(join(root, "flows")).filter((n) => n.endsWith(".yaml")).sort()) {
    const def = parseYaml(readFileSync(join(root, "flows", f), "utf8")) as { steps?: { id: string; type?: string; run?: unknown; repo_access?: unknown }[] };
    hits.push(...scanSteps(f.replace(/\.yaml$/, ""), def.steps ?? [], tools));
  }
  return hits;
}
