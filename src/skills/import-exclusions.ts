import { EXCLUSION_CODES, EXCLUSION_FILES, EXCLUSION_KEYS, NETWORK_USE_RULES, type ExclusionCode } from "./import-review-rules.js";
import { boundReasons, byteCmp } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import { decodeText, fileClass } from "./scan.js";
import { shownValue } from "./sources.js";

// Why an imported skill may not be promoted: it needs a live integration, uses the network or ships plugin or MCP
// configuration. Pure: reads only the normalized skill. The network-use check is a text heuristic, not proof.

export interface ImportExclusion {
  code: ExclusionCode;
  text: string;
}

/** Why the skill may not be promoted, or []. Sorted by EXCLUSION_CODES order, then text. No duplicates. */
export function importExclusions(skill: NormalizedSkill): ImportExclusion[] {
  const { package: pkg, provenance, extraFiles } = skill;
  const found = new Map<string, ImportExclusion>();
  const add = (code: ExclusionCode, text: string) => found.set(code + "\0" + text, { code, text });

  for (const c of pkg.connectors) add("connector", `needs the connector ${shownValue(c)}`);
  if (pkg.tool_profile.network === true) add("network", "needs network access");

  const files: { path: string; content: Uint8Array }[] = [];
  for (const list of Object.values(pkg.files)) for (const f of list) files.push({ path: f.path, content: f.content });
  for (const f of extraFiles) files.push({ path: f.path, content: f.content });

  const texts: { path: string; text: string; script: boolean }[] = [{ path: "SKILL.md", text: pkg.instructions, script: false }];
  for (const f of files) {
    const text = decodeText(f.content);
    if (text !== undefined) texts.push({ path: f.path, text, script: fileClass(f.path, text) === "script" });
  }
  for (const t of texts) {
    for (const rule of NETWORK_USE_RULES) {
      if (rule.scope === "script" && !t.script) continue;
      if (rule.scope === "shell" && !t.script && !pkg.tool_profile.shell) continue;
      if (rule.re.test(t.text)) add("network-use", `${rule.says} (${shownValue(t.path)})`);
    }
  }

  for (const f of files) {
    const parts = f.path.toLowerCase().split("/");
    const base = parts[parts.length - 1]!;
    for (const rule of EXCLUSION_FILES) {
      const hit = (rule.name !== undefined && base === rule.name) || (rule.segment !== undefined && parts.includes(rule.segment));
      if (hit) add(rule.code, `${rule.code === "mcp-config" ? "ships MCP configuration" : "ships plugin configuration"} (${shownValue(f.path)})`);
    }
  }

  const upstream = provenance.upstream;
  for (const k of EXCLUSION_KEYS) {
    const own = pkg.metadata !== undefined && Object.hasOwn(pkg.metadata, k);
    if (own || ["frontmatter", "metadata", "manifest"].some((p) => Object.hasOwn(upstream, `${p}.${k}`))) add("integration-key", `declares ${k}`);
  }

  return [...found.values()].sort((a, b) => EXCLUSION_CODES.indexOf(a.code) - EXCLUSION_CODES.indexOf(b.code) || byteCmp(a.text, b.text));
}

/** Fixed sentences, bounded with boundReasons. */
export function exclusionReasons(list: readonly ImportExclusion[]): string[] {
  return boundReasons(list.map((x) => x.text));
}
