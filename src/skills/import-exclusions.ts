import { createHash } from "node:crypto";
import {
  CODE_EXTENSIONS, EXCLUSION_CODES, EXCLUSION_FILES, EXCLUSION_KEYS, NETWORK_USE_RULES, READ_ONLY_FOLDERS, WEB_ADDRESS_LIST_RE,
  type ExclusionCode,
} from "./import-review-rules.js";
import { boundReasons, byteCmp } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import { decodeText, fileClass } from "./scan.js";
import { shownValue } from "./sources.js";

// Why an imported skill may not be promoted: it needs a live integration, uses the network or ships plugin or MCP
// configuration. Pure: reads only the normalized skill. The network-use check is a text heuristic, not proof.
// A web address in code blocks; one in a file the agent only reads (Markdown, data, references/, evals/) is only listed.

export type AddressUse = "called" | "mentioned";
/** `path` and `address` are already safe to print. */
export interface WebAddress {
  path: string;
  address: string;
  use: AddressUse;
  why: string;
}

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

  for (const t of skillTexts(skill)) {
    for (const rule of NETWORK_USE_RULES) {
      if (rule.scope === "script" && !t.script) continue;
      if (rule.scope === "code" && !t.code) continue;
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

/** The instructions and every text file of the skill. `code`: addressUse says the file is called, so a web address in it blocks. */
function skillTexts(skill: NormalizedSkill): { path: string; text: string; script: boolean; code: boolean }[] {
  const { package: pkg, extraFiles } = skill;
  const texts = [{ path: "SKILL.md", text: pkg.instructions, script: false, code: false }];
  const files: { path: string; content: Uint8Array }[] = [];
  for (const list of Object.values(pkg.files)) for (const f of list) files.push({ path: f.path, content: f.content });
  for (const f of extraFiles) files.push({ path: f.path, content: f.content });
  for (const f of files) {
    const text = decodeText(f.content);
    if (text !== undefined) texts.push({ path: f.path, text, script: fileClass(f.path, text) === "script", code: addressUse(f.path, text).use === "called" });
  }
  return texts;
}

/** Whether a web address in this file is called (the file is code) or only mentioned (the agent reads it). `why` is a fixed sentence. */
export function addressUse(path: string, text: string): { use: AddressUse; why: string } {
  const parts = path.split("/");
  const folders = parts.slice(0, -1);
  const base = parts[parts.length - 1]!;
  if (folders.includes("scripts")) return { use: "called", why: "under scripts/, which is code" };
  if (text.startsWith("#!")) return { use: "called", why: "starts with #!, so it is code" };
  const folder = READ_ONLY_FOLDERS.find((f) => folders.includes(f));
  if (folder !== undefined) return { use: "mentioned", why: `under ${folder}/, which the agent only reads` };
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { use: "called", why: "a file without an extension counts as code" };
  const ext = base.slice(dot).toLowerCase();
  if (CODE_EXTENSIONS.includes(ext)) return { use: "called", why: `a ${ext} file is code` };
  return { use: "mentioned", why: "a document or data file, which the agent only reads" };
}

/** A web address that is safe to print: user and password hidden, credential looks hidden, cut at 80 characters with a hash so that cut addresses stay distinct. */
export function shownAddress(raw: string): string {
  const noUser = raw.replace(/^(https?:\/\/)[^\/?#\s]{0,200}@/i, "$1(hidden)@");
  // A value after ?, &, ; or # whose name sounds like a credential is never shown.
  const noQuery = noUser.replace(/([?&;#][\w.%-]{0,60}?(?:key|token|secret|pass|pwd|auth|sig|cred|session|sid|code)[\w.%-]{0,40}=)[^&;#\s]{0,2048}/gi, "$1(hidden)");
  const redacted = shownValue(noQuery);
  if (redacted.length <= 80) return redacted;
  return shownValue(redacted.slice(0, 80)) + "… #" + createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

/** Every web address of the skill with its decision, sorted by path, then address. Never blocks: only importExclusions does. `skillMd`: the raw SKILL.md, which has the frontmatter. */
export function webAddresses(skill: NormalizedSkill, skillMd?: string): WebAddress[] {
  const found = new Map<string, { path: string; raw: string; text: string }>();
  for (const t of skillTexts(skill)) {
    const text = t.path === "SKILL.md" && skillMd !== undefined ? skillMd : t.text;
    WEB_ADDRESS_LIST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WEB_ADDRESS_LIST_RE.exec(text)) !== null) found.set(t.path + "\0" + m[0], { path: t.path, raw: m[0], text });
  }
  WEB_ADDRESS_LIST_RE.lastIndex = 0;
  return [...found.values()]
    .sort((a, b) => byteCmp(a.path, b.path) || byteCmp(a.raw, b.raw))
    .map((e) => ({ path: shownValue(e.path), address: shownAddress(e.raw), ...addressUse(e.path, e.text) }));
}

/** One output line per address. */
export function addressLines(skillId: string, list: readonly WebAddress[]): string[] {
  return list.map((a) => `ADDRESS ${skillId} ${a.use} ${a.path}: ${a.address} (${a.why})`);
}

/** Fixed sentences, bounded with boundReasons. */
export function exclusionReasons(list: readonly ImportExclusion[]): string[] {
  return boundReasons(list.map((x) => x.text));
}
