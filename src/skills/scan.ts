// The static scanner for imported skills. Pure: no file system, no process, no clock, and nothing here runs
// the content it reads. Called by `scf skills scan` (cli.ts). The rules are in scan-rules.ts.
import { createHash } from "node:crypto";
import { credentialHits, credentialProblem, riskyFileName, type CredentialHit } from "./credential-scan.js";
import { byteCmp } from "./import-plan.js";
import type { ExternalSkill } from "./normalize.js";
import { skillDigest } from "./package.js";
import { relativePathProblem } from "./schema.js";
import { shownValue } from "./sources.js";
import {
  ALLOWED_BINARY, DOC_EXTENSIONS, DOC_NAMES, FIXED_RULES, MAGIC_RULES, SCAN_ID_HEADER, TEXT_RULES, categoryOf,
  type FixedRule, type ScanCategory, type ScanSeverity, type TextRule,
} from "./scan-rules.js";

export interface ScanFinding {
  id: string;
  rule: string;
  category: ScanCategory;
  severity: ScanSeverity;
  /** The path as it is safe to print. */
  path: string;
  line?: number;
  evidence: string;
}
export interface ScanReport {
  schema: 1;
  digest: string;
  findings: ScanFinding[];
}

/** The id of one finding: a hash of the header, the rule, the raw path and the matched text. */
export function findingId(rule: string, path: string, matched: string): string {
  return createHash("sha256").update(SCAN_ID_HEADER + rule + "\0" + path + "\0" + matched).digest("hex").slice(0, 16);
}

const GLOBAL_TEXT_RULES: readonly (TextRule & { global: RegExp })[] = TEXT_RULES.map((r) => ({ ...r, global: new RegExp(r.re.source, r.re.flags + "g") }));
const STRICT = new TextDecoder("utf-8", { fatal: true });
const LOSSY = new TextDecoder("utf-8");
const BIDI = /[‪-‮⁦-⁩‎‏؜]/u;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL = /\p{Cc}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;

type FileClass = "script" | "doc";
interface Entry {
  finding: ScanFinding;
  rawPath: string;
}

/** The text of a file, or undefined when it is not valid UTF-8 or holds a NUL byte. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return STRICT.decode(bytes);
  } catch {
    return undefined;
  }
}

export function fileClass(path: string, text: string): FileClass {
  if (path.startsWith("scripts/") || text.startsWith("#!")) return "script";
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : "";
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (DOC_EXTENSIONS.includes(extension) || DOC_NAMES.includes(stem.toUpperCase())) return "doc";
  return "script";
}

/** The offsets of every newline; `lineOf` finds the 1-based line of an offset by binary search. */
function lineIndex(text: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i);
  return out;
}
function lineOf(newlines: readonly number[], offset: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlines[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

const hasBytes = (bytes: Uint8Array, offset: number, want: readonly number[]): boolean =>
  bytes.length >= offset + want.length && want.every((b, i) => bytes[offset + i] === b);

/** The finding of one file, with the dedupe by id and the smallest line. */
class FileScan {
  constructor(private readonly rawPath: string, private readonly out: Map<string, Entry>, private readonly lines: () => readonly number[]) {}

  add(rule: { id: string; severity: ScanSeverity }, matched: string, evidence: string, offset?: number): void {
    const id = findingId(rule.id, this.rawPath, matched);
    const line = offset === undefined ? undefined : lineOf(this.lines(), offset);
    const old = this.out.get(id);
    if (old) {
      if (line !== undefined && (old.finding.line === undefined || line < old.finding.line)) old.finding.line = line;
      return;
    }
    const finding: ScanFinding = { id, rule: rule.id, category: categoryOf(rule.id), severity: rule.severity, path: shownValue(this.rawPath), evidence };
    if (line !== undefined) finding.line = line;
    this.out.set(id, { finding, rawPath: this.rawPath });
  }
}

/** Each credential is reported by position and rule name, never by value. */
function scanSecrets(scan: FileScan, body: string, hits: readonly CredentialHit[]): void {
  for (const h of hits) scan.add(FIXED_RULES.secretContent, body.slice(h.start, h.end), `${FIXED_RULES.secretContent.says} (${h.rule})`, h.start);
}

function evidenceOf(rule: TextRule, matched: string, hasSecret: boolean): string {
  if (rule.excerpt === false) return `${rule.says} (${matched.length} characters)`;
  if (hasSecret) return rule.says;
  const shown = shownValue(matched);
  return shown === "(hidden)" ? rule.says : `${rule.says}: ${shown}`;
}

function scanText(scan: FileScan, body: string, klass: FileClass, hasSecret: boolean): void {
  for (const rule of GLOBAL_TEXT_RULES) {
    if (rule.scope === "script" && klass !== "script") continue;
    const re = rule.global;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      if (m[0] === "") re.lastIndex++;
      else scan.add(rule, m[0], evidenceOf(rule, m[0], hasSecret), m.index);
    }
  }
}

/** Magic rules; true when one matched. */
function scanMagic(scan: FileScan, bytes: Uint8Array): boolean {
  let found = false;
  for (const rule of MAGIC_RULES) {
    if (!hasBytes(bytes, rule.offset, rule.bytes)) continue;
    scan.add(rule, "", rule.says);
    found = true;
  }
  return found;
}

function scanBinary(scan: FileScan, bytes: Uint8Array, path: string, magic: boolean): void {
  if (magic) return;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (ALLOWED_BINARY.some((a) => a.extensions.includes(extension) && a.parts.every((p) => hasBytes(bytes, p.offset, p.bytes)))) return;
  scan.add(FIXED_RULES.unknownBinary, "", FIXED_RULES.unknownBinary.says);
}

/** One finding per distinct code point. */
function scanChars(scan: FileScan, text: string): void {
  const seen = new Set<string>();
  let prev = "";
  let offset = 0;
  for (const ch of text) {
    const at = offset;
    offset += ch.length;
    const before = prev;
    prev = ch;
    if (ch < " " ? ch === "\t" || ch === "\n" || ch === "\r" : ch < "\u007f") continue;
    if (seen.has(ch)) continue;
    let rule: FixedRule;
    if (BIDI.test(ch)) rule = FIXED_RULES.bidiChars;
    else if (INVISIBLE.test(ch)) {
      if (ch === "‍" && (before === "️" || PICTOGRAPH.test(before) || EMOJI_MODIFIER.test(before))) continue;
      rule = FIXED_RULES.invisibleChars;
    } else if (CONTROL.test(ch)) rule = FIXED_RULES.controlChars;
    else continue;
    seen.add(ch);
    scan.add(rule, ch, `${rule.says}: ${shownValue(ch)}`, at);
  }
}

interface Prepared {
  path: string;
  bytes: Uint8Array;
  text: string | undefined;
  body: string;
  hits: CredentialHit[];
}

function prepare(file: { path: string; content: Uint8Array }): Prepared {
  const text = decodeText(file.content);
  const body = text ?? LOSSY.decode(file.content);
  return { path: file.path, bytes: file.content, text, body, hits: credentialHits(body) };
}

/** `hasSecret`: some file with this path holds a credential, so no finding of any of them gets an excerpt. */
function scanFile(file: Prepared, hasSecret: boolean, out: Map<string, Entry>): void {
  const { path: rawPath, bytes, text, body } = file;
  let newlines: number[] | undefined;
  const scan = new FileScan(rawPath, out, () => (newlines ??= lineIndex(body)));

  scanSecrets(scan, body, file.hits);
  if (credentialProblem(rawPath)) scan.add(FIXED_RULES.secretFileName, "", FIXED_RULES.secretFileName.says);
  if (riskyFileName(rawPath)) scan.add(FIXED_RULES.credentialFile, "", FIXED_RULES.credentialFile.says);
  if (relativePathProblem(rawPath)) scan.add(FIXED_RULES.filePath, "", FIXED_RULES.filePath.says);
  const magic = scanMagic(scan, bytes);
  scanText(scan, body, fileClass(rawPath, body), hasSecret);
  if (text === undefined) scanBinary(scan, bytes, rawPath, magic);
  else scanChars(scan, text);
}

/** Scans one skill without running it. Pure; never throws for bad content. */
export function scanSkill(skill: ExternalSkill): ScanReport {
  const out = new Map<string, Entry>();
  const files = [...skill.files].sort((a, b) => byteCmp(a.path, b.path));
  const prepared = files.map(prepare);
  const secretPaths = new Set(prepared.filter((p) => p.hits.length > 0).map((p) => p.path));
  for (const file of prepared) scanFile(file, secretPaths.has(file.path), out);

  // Paths are ranked once in byte order; rule ids and finding ids are ASCII, where code unit order is byte order.
  const rank = new Map<string, number>();
  files.forEach((f, i) => {
    if (!rank.has(f.path)) rank.set(f.path, i);
  });
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...out.values()].sort(
    (x, y) => rank.get(x.rawPath)! - rank.get(y.rawPath)! || order(x.finding.rule, y.finding.rule) || order(x.finding.id, y.finding.id),
  );
  return { schema: 1, digest: skillDigest(skill.files), findings: entries.map((e) => e.finding) };
}
