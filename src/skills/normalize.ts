import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { estimateTokens } from "./catalogue.js";
import { credentialProblem, riskyFileName } from "./credential-scan.js";
import { boundReasons, byteCmp, type ImportRecord, type RejectedSkill } from "./import-plan.js";
import { canonicalJson, plainProblem } from "./normalize-values.js";
import {
  FIELD_ALIASES, MCP_TOOL_PREFIX, NORMALIZE_ID_HEADER, NORMALIZE_LIMITS, SKILL_LAYOUTS, STANDARD_KEYS, TOOL_EFFECTS,
} from "./normalize-rules.js";
import { skillDigest, splitFrontmatter } from "./package.js";
import { skillContextTokens } from "./resolve.js";
import {
  SKILL_FOLDERS, SKILL_ID_RE, SKILL_RISKS, SKILL_VERSION_RE, SkillToolProfileSchema,
  type SkillFile, type SkillFolder, type SkillPackage, type SkillRisk, type SkillToolProfile,
} from "./schema.js";
import { shownValue } from "./sources.js";

// Turns the skills of a prepared import (import-plan.ts) into SkillPackage values with source-qualified ids, and reports
// every skill that cannot be mapped completely. Pure: no file system, no process, no clock. Nothing calls it yet.

export interface NormalizeOrigin {
  source: string;
  repository: string;
  repositoryKey: string;
  commit: string;
}
/** Paths are relative to the skill root. */
export interface ExternalSkill {
  root: string;
  files: readonly { path: string; content: Uint8Array }[];
}
export interface SkillProvenance {
  schema: 1;
  source: string;
  repository: string;
  repositoryKey: string;
  commit: string;
  root: string;
  /** The upstream name; the package id is source-qualified. */
  name: string;
  layout: (typeof SKILL_LAYOUTS)[number];
  versionDeclared: boolean;
  dependencies: { name: string; id: string }[];
  technologies: { name: string; version?: string }[];
  requiredTools: string[];
  entryPoints: { instructions: "SKILL.md"; scripts: string[]; documents: string[] };
  context: { instructions: number; text: number };
  /** Unrecognised upstream metadata: `frontmatter.<key>`, `metadata.<key>` or `manifest.<key>` → canonical JSON. */
  upstream: Record<string, string>;
}
export interface NormalizedSkill {
  package: SkillPackage;
  provenance: SkillProvenance;
  extraFiles: SkillFile[];
}
export interface NormalizationReport {
  schema: 1;
  source: string;
  repositoryKey: string;
  commit: string;
  normalized: { root: string; id: string; name: string; version: string; digest: string; layout: string }[];
  quarantined: RejectedSkill[];
}
export type NormalizeResult = { ok: true; skill: NormalizedSkill } | { ok: false; reasons: string[] };

const SKILL_MD = "SKILL.md";
const MANIFEST = "skill.yaml";
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RISK_RANK: Record<SkillRisk, number> = { low: 0, medium: 1, high: 2 };

const isStr = (v: unknown): v is string => typeof v === "string";
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** `source-name` cut to a readable prefix, then a hash of source, repository and name (so `a-b`+`c` and `a`+`b-c` differ). */
export function sourceQualifiedId(origin: Pick<NormalizeOrigin, "source" | "repositoryKey">, name: string): string {
  const readable = `${origin.source}-${name}`.slice(0, NORMALIZE_LIMITS.idReadable).replace(/-+$/, "");
  const hash = createHash("sha256").update(`${NORMALIZE_ID_HEADER}${origin.source}\0${origin.repositoryKey}\0${name}`, "utf8").digest("hex").slice(0, NORMALIZE_LIMITS.idHash);
  return `${readable}-${hash}`;
}

function buildReport(
  origin: Pick<NormalizeOrigin, "source" | "repositoryKey" | "commit">,
  normalized: NormalizationReport["normalized"],
  rejected: readonly RejectedSkill[],
): NormalizationReport {
  return {
    schema: 1,
    source: origin.source,
    repositoryKey: origin.repositoryKey,
    commit: origin.commit,
    normalized: [...normalized].sort((a, b) => byteCmp(a.root, b.root)),
    quarantined: rejected
      .map((r) => ({ root: r.root, reasons: [...r.reasons] }))
      .sort((a, b) => byteCmp(a.root, b.root) || byteCmp(a.reasons[0] ?? "", b.reasons[0] ?? "")),
  };
}

/** A report with no normalized skill, for an import in which no skill could be staged (SkillImportError `nothing-staged`). */
export function quarantineReport(origin: Pick<NormalizeOrigin, "source" | "repositoryKey" | "commit">, rejected: readonly RejectedSkill[]): NormalizationReport {
  return buildReport(origin, [], rejected);
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Text or a list of text. A string is split at commas. Undefined when it is neither. */
function textList(v: unknown): string[] | undefined {
  if (isStr(v)) return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (!isStr(item)) return undefined;
    out.push(item.trim());
  }
  return out.filter((s) => s !== "");
}

/** `v1.2` → 1.2.0, `2` → 2.0.0. A YAML number other than an integer is refused (`1.10` is read as `1.1`). */
function coerceVersion(v: unknown): string | undefined {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return undefined;
    s = String(v);
  } else if (isStr(v)) s = v.trim().replace(/^v/, "");
  else return undefined;
  if (/^\d+$/.test(s)) s += ".0.0";
  else if (/^\d+\.\d+$/.test(s)) s += ".0";
  return SKILL_VERSION_RE.test(s) ? s : undefined;
}

/** Split on spaces and commas outside parentheses. Undefined when parentheses do not match. */
function splitTools(text: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (--depth < 0) return undefined;
    }
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0) return undefined;
  if (cur) out.push(cur);
  return out;
}

interface ParsedDependency {
  name: string;
  version?: string;
  /** Keys of a map entry that were not used: kept as provenance. */
  extra: [string, unknown][];
}

function parseDependencies(v: unknown): ParsedDependency[] | string {
  const list: unknown[] | undefined = isStr(v) ? textList(v) : Array.isArray(v) ? v : undefined;
  if (!list) return "dependencies: must be a list";
  const out: ParsedDependency[] = [];
  for (const entry of list) {
    let name: unknown;
    let ver: unknown;
    let extra: [string, unknown][] = [];
    if (isStr(entry)) {
      const text = entry.trim();
      const at = text.indexOf("@", 1);
      name = at < 0 ? text : text.slice(0, at);
      ver = at < 0 ? undefined : text.slice(at + 1);
    } else if (isMap(entry)) {
      const nameKey = entry.name !== undefined && entry.name !== null ? "name" : "id";
      const verKey = entry.version !== undefined && entry.version !== null ? "version" : "min_version";
      name = entry[nameKey];
      ver = entry[verKey];
      extra = Object.entries(entry).filter(([k]) => k !== nameKey && k !== verKey);
    } else return "dependencies: an entry is not text or a map";
    if (!isStr(name) || !SKILL_ID_RE.test(name)) return "dependencies: a name is not a lower-case slug";
    if (ver === undefined || ver === null) out.push({ name, extra });
    else {
      const min = coerceVersion(ver);
      if (min === undefined) return "dependencies: a version cannot be read as a version like 1.2.3";
      out.push({ name, version: min, extra });
    }
  }
  return out;
}

function parseTechnologies(v: unknown): { name: string; version?: string }[] | string {
  const bad = "technologies: must be a map of names to ranges or a list of names";
  const pairs: [string, unknown][] = [];
  if (isMap(v)) pairs.push(...Object.entries(v));
  else {
    const list = textList(v);
    if (!list) return bad;
    for (const item of list) {
      const at = item.indexOf("@", 1);
      pairs.push(at < 0 ? [item, undefined] : [item.slice(0, at), item.slice(at + 1)]);
    }
  }
  const out: { name: string; version?: string }[] = [];
  for (const [rawName, range] of pairs) {
    const name = slugify(rawName);
    if (!SKILL_ID_RE.test(name)) return "technologies: a name is not usable";
    let version: string | undefined;
    if (range !== undefined && range !== null) {
      const text = typeof range === "number" && Number.isSafeInteger(range) ? String(range) : range;
      if (!isStr(text)) return "technologies: a range is not text";
      if (text.length > NORMALIZE_LIMITS.rangeChars) return `technologies: a range is longer than ${NORMALIZE_LIMITS.rangeChars} characters`;
      if (text.trim() !== "") version = text;
    }
    out.push(version === undefined ? { name } : { name, version });
  }
  if (out.length > NORMALIZE_LIMITS.technologies) return `technologies: more than ${NORMALIZE_LIMITS.technologies} entries`;
  if (new Set(out.map((t) => t.name)).size !== out.length) return "technologies: a name is listed twice";
  return out.sort((a, b) => byteCmp(a.name, b.name));
}

const decodeUtf8 = (b: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
};

/** One skill. Collects every reason; never throws for bad skill content. */
export function normalizeSkill(origin: NormalizeOrigin, skill: ExternalSkill): NormalizeResult {
  const reasons: string[] = [];
  const fail = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const files = [...skill.files].sort((a, b) => byteCmp(a.path, b.path));

  // 1. Credentials: only the rule name is reported, never a value or the text of a path.
  const found = new Set<string>();
  for (const f of files) {
    const nameRule = credentialProblem(f.path);
    if (nameRule) found.add(`a file name looks like a credential (${nameRule})`);
    else if (riskyFileName(f.path)) found.add("a file is a credential file by its name");
    const c = f.content;
    const rule = credentialProblem(Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("latin1"));
    if (rule) found.add(`a file holds what looks like a credential or a live endpoint (${rule})`);
  }
  if (found.size) return { ok: false, reasons: [...found].sort(byteCmp) };

  // 2. Documents
  const mdFile = files.find((f) => f.path === SKILL_MD);
  if (!mdFile) return { ok: false, reasons: [`${SKILL_MD}: missing`] };
  const mdText = decodeUtf8(mdFile.content);
  if (mdText === undefined) return { ok: false, reasons: [`${SKILL_MD}: is not UTF-8`] };
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const split = splitFrontmatter(mdText);
    if (!isMap(split.data)) throw new Error("not a map");
    fm = split.data;
    body = split.body.trim();
  } catch {
    return { ok: false, reasons: [`${SKILL_MD}: has no valid frontmatter`] };
  }
  const fmProblem = plainProblem(fm);
  if (fmProblem) return { ok: false, reasons: [`${SKILL_MD}: ${fmProblem}`] };

  let manifest: Record<string, unknown> | undefined;
  const mf = files.find((f) => f.path === MANIFEST);
  if (mf) {
    const text = decodeUtf8(mf.content);
    if (text === undefined) return { ok: false, reasons: [`${MANIFEST}: is not UTF-8`] };
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch {
      return { ok: false, reasons: [`${MANIFEST}: is not valid YAML`] };
    }
    if (!isMap(raw)) return { ok: false, reasons: [`${MANIFEST}: must be a map of keys and values`] };
    const problem = plainProblem(raw);
    if (problem) return { ok: false, reasons: [`${MANIFEST}: ${problem}`] };
    manifest = raw;
  }

  // 3. Required fields
  const name = isStr(fm.name) && SKILL_ID_RE.test(fm.name) ? fm.name : undefined;
  if (name === undefined) fail(`${SKILL_MD}: name must be a lower-case slug of 1–64 characters`);
  const rawDescription = fm.description;
  const description = isStr(rawDescription) ? rawDescription.trim() : "";
  if (description.length < 1 || description.length > 1024) fail(`${SKILL_MD}: description must be 1 to 1024 characters`);
  if (!body) fail(`${SKILL_MD}: no instructions after the frontmatter`);

  // 4. Field reader: skill.yaml, then top-level frontmatter, then the metadata map. The first source with an alias wins.
  let metaMap: Record<string, unknown> | undefined;
  if (fm.metadata !== undefined && fm.metadata !== null) {
    if (isMap(fm.metadata)) metaMap = fm.metadata;
    else fail(`${SKILL_MD}: metadata must be a map`);
  }
  const docs: ["manifest" | "frontmatter" | "metadata", Record<string, unknown>][] = [];
  if (manifest) docs.push(["manifest", manifest]);
  docs.push(["frontmatter", fm]);
  if (metaMap) docs.push(["metadata", metaMap]);
  const consumed = new Set<string>(STANDARD_KEYS.map((k) => `frontmatter.${k}`));
  let fromExtended = false;
  let fromMetadata = false;
  const read = (aliases: readonly string[]): unknown => {
    for (const [source, doc] of docs) {
      for (const key of aliases) {
        if (!has(doc, key)) continue;
        consumed.add(`${source}.${key}`);
        if (source === "frontmatter" && !(STANDARD_KEYS as readonly string[]).includes(key)) fromExtended = true;
        if (source === "metadata") fromMetadata = true;
        const v = doc[key];
        return v === null ? undefined : v;
      }
    }
    return undefined;
  };

  // version
  const rawVersion = read(FIELD_ALIASES.version);
  let version = `0.0.0-g${origin.commit.slice(0, 12)}`;
  if (rawVersion !== undefined) {
    const v = coerceVersion(rawVersion);
    if (v === undefined) fail("version: cannot be read as a version like 1.2.3");
    else version = v;
  }

  // capabilities and category
  let capabilities: string[] = [];
  const rawCaps = read(FIELD_ALIASES.capabilities);
  if (rawCaps !== undefined) {
    const list = textList(rawCaps);
    if (!list) fail("capabilities: must be a list of text");
    else {
      const slugs = list.map(slugify);
      if (slugs.some((s) => !SKILL_ID_RE.test(s))) fail("capabilities: an entry cannot be made a lower-case slug of 1–64 characters");
      else {
        capabilities = [...new Set(slugs)].sort(byteCmp);
        if (capabilities.length > 32) fail("capabilities: more than 32 entries");
      }
    }
  }
  let category = "general";
  const rawCategory = read(FIELD_ALIASES.category);
  if (rawCategory !== undefined) {
    const s = isStr(rawCategory) ? slugify(rawCategory) : "";
    if (!SKILL_ID_RE.test(s)) fail("category: cannot be made a lower-case slug of 1–64 characters");
    else category = s;
  }

  // dependencies
  const dependencies: { id: string; min_version?: string }[] = [];
  const depNames: { name: string; id: string }[] = [];
  const depExtra: [string, unknown][] = [];
  const rawDeps = read(FIELD_ALIASES.dependencies);
  if (rawDeps !== undefined) {
    const parsed = parseDependencies(rawDeps);
    if (isStr(parsed)) fail(parsed);
    else {
      const seen = new Set<string>();
      for (const d of parsed) {
        const id = sourceQualifiedId(origin, d.name);
        if (d.name === name) fail("dependencies: a skill cannot depend on itself");
        else if (seen.has(d.name)) fail("dependencies: a name is listed twice");
        seen.add(d.name);
        dependencies.push(d.version === undefined ? { id } : { id, min_version: d.version });
        depNames.push({ name: d.name, id });
        for (const [k, value] of d.extra) depExtra.push([`dependencies.${d.name}.${k}`, value]);
      }
      if (parsed.length > 32) fail("dependencies: more than 32 entries");
      dependencies.sort((a, b) => byteCmp(a.id, b.id));
      depNames.sort((a, b) => byteCmp(a.id, b.id));
    }
  }

  // technologies
  let technologies: { name: string; version?: string }[] = [];
  const rawTech = read(FIELD_ALIASES.technologies);
  if (rawTech !== undefined) {
    const parsed = parseTechnologies(rawTech);
    if (isStr(parsed)) fail(parsed);
    else technologies = parsed;
  }

  // compatibility, license
  let license: string | undefined;
  if (fm.license !== undefined && fm.license !== null) {
    if (isStr(fm.license) && fm.license.length <= 200) license = fm.license.trim();
    else fail(`${SKILL_MD}: license must be text of at most 200 characters`);
  }
  let compatibility: string | undefined;
  if (fm.compatibility !== undefined && fm.compatibility !== null) {
    if (isStr(fm.compatibility) && fm.compatibility.length <= 500) compatibility = fm.compatibility;
    else fail(`${SKILL_MD}: compatibility must be text of at most 500 characters`);
  }

  // 5. Tools, connectors, risk
  const toolNames = new Set<string>();
  let allowedTools: string | undefined;
  const addTools = (text: string, label: string) => {
    const parts = splitTools(text);
    if (!parts) return fail(`${label}: parentheses do not match`);
    for (const p of parts) {
      const tool = p.split("(")[0]!.trim();
      if (!TOOL_NAME_RE.test(tool)) return fail(`${label}: a tool name is not valid`);
      toolNames.add(tool);
    }
  };
  if (fm["allowed-tools"] !== undefined && fm["allowed-tools"] !== null) {
    const at = fm["allowed-tools"];
    if (isStr(at) && at.length <= 500) {
      allowedTools = at;
      addTools(at, "allowed-tools");
    } else fail(`${SKILL_MD}: allowed-tools must be text of at most 500 characters`);
  }
  const rawTools = read(FIELD_ALIASES.tools);
  if (rawTools !== undefined) {
    const list = isStr(rawTools) ? [rawTools] : Array.isArray(rawTools) && rawTools.every(isStr) ? rawTools : undefined;
    if (!list) fail("tools: must be text or a list of text");
    else for (const t of list) addTools(t, "tools");
  }
  if (toolNames.size > NORMALIZE_LIMITS.tools) fail(`tools: more than ${NORMALIZE_LIMITS.tools} tools`);

  const declared: SkillToolProfile = { shell: false, network: false, filesystem: "read" };
  let declaredRisk: SkillRisk = "low";
  const connectorSet = new Set<string>();
  if (manifest) {
    consumed.add("manifest.tool_profile").add("manifest.connectors").add("manifest.risk");
    if (manifest.tool_profile !== undefined) {
      const r = SkillToolProfileSchema.safeParse(manifest.tool_profile);
      if (r.success) Object.assign(declared, r.data);
      else fail(`${MANIFEST}: tool_profile is not valid`);
    }
    if (manifest.connectors !== undefined) {
      const list = Array.isArray(manifest.connectors) ? manifest.connectors : undefined;
      if (!list || !list.every((c) => isStr(c) && SKILL_ID_RE.test(c))) fail(`${MANIFEST}: connectors must be a list of lower-case slugs`);
      else for (const c of list) if (isStr(c)) connectorSet.add(c);
    }
    if (manifest.risk !== undefined) {
      const level = SKILL_RISKS.find((r) => r === manifest.risk);
      if (level) declaredRisk = level;
      else fail(`${MANIFEST}: risk must be low, medium or high`);
    }
  }
  const hasScripts = files.some((f) => f.path.startsWith("scripts/"));
  let shell = declared.shell || hasScripts;
  let network = declared.network;
  let write = declared.filesystem === "write";
  let unlisted = false;
  for (const tool of toolNames) {
    if (tool.startsWith(MCP_TOOL_PREFIX)) {
      const server = slugify(tool.slice(MCP_TOOL_PREFIX.length).split("__")[0]!);
      if (!SKILL_ID_RE.test(server)) fail("tools: an MCP tool has no usable server name");
      else connectorSet.add(server);
      continue;
    }
    const effect = has(TOOL_EFFECTS, tool) ? TOOL_EFFECTS[tool] : undefined;
    if (effect === undefined) {
      unlisted = true;
      shell = network = write = true;
    } else if (effect === "shell") shell = true;
    else if (effect === "network") network = true;
    else if (effect === "write") write = true;
  }
  if (connectorSet.size > NORMALIZE_LIMITS.connectors) fail(`connectors: more than ${NORMALIZE_LIMITS.connectors} connectors`);
  const connectors = [...connectorSet].sort(byteCmp);
  const derived: SkillRisk = shell || network || connectors.length || unlisted ? "medium" : "low";
  const risk = RISK_RANK[declaredRisk] > RISK_RANK[derived] ? declaredRisk : derived;
  const toolProfile: SkillToolProfile = { shell, network, filesystem: write ? "write" : "read" };

  // 6. Metadata map and unknown metadata
  const upstream: Record<string, string> = {};
  for (const [k, value] of depExtra) upstream[k] = canonicalJson(value);
  // Built from entries, not by assignment: a key such as `__proto__` must stay an own property.
  const metadata: [string, string][] = [];
  if (metaMap) {
    for (const [k, v] of Object.entries(metaMap)) {
      if (isStr(v)) metadata.push([k, v]);
      else if (!consumed.has(`metadata.${k}`)) upstream[`metadata.${k}`] = canonicalJson(v);
    }
  }
  for (const k of Object.keys(fm)) if (!consumed.has(`frontmatter.${k}`)) upstream[`frontmatter.${k}`] = canonicalJson(fm[k]);
  if (manifest) {
    for (const k of Object.keys(manifest)) {
      // The declared needs are kept as written too: the package value can be higher than the declared one.
      if (!consumed.has(`manifest.${k}`) || k === "tool_profile" || k === "connectors" || k === "risk") upstream[`manifest.${k}`] = canonicalJson(manifest[k]);
    }
  }
  const sortedUpstream: Record<string, string> = {};
  let upstreamBytes = 0;
  for (const k of Object.keys(upstream).sort(byteCmp)) {
    sortedUpstream[k] = upstream[k]!;
    upstreamBytes += Buffer.byteLength(k) + Buffer.byteLength(upstream[k]!);
  }
  if (upstreamBytes > NORMALIZE_LIMITS.upstreamBytes) fail(`upstream metadata is larger than ${NORMALIZE_LIMITS.upstreamBytes} bytes`);

  if (reasons.length || name === undefined) return { ok: false, reasons };

  // 7. Files
  const folders = Object.fromEntries(SKILL_FOLDERS.map((f) => [f, [] as SkillFile[]])) as Record<SkillFolder, SkillFile[]>;
  const extraFiles: SkillFile[] = [];
  for (const f of files) {
    if (f.path === SKILL_MD) continue;
    const file: SkillFile = { path: f.path, size: f.content.byteLength, content: f.content };
    const top = f.path.split("/")[0]!;
    if (f.path.includes("/") && (SKILL_FOLDERS as readonly string[]).includes(top)) folders[top as SkillFolder].push(file);
    else extraFiles.push(file);
  }
  const scripts = files.filter((f) => f.path.startsWith("scripts/")).map((f) => f.path);
  const documents = files.filter((f) => f.path !== SKILL_MD && f.path.endsWith(".md")).map((f) => f.path);
  let textTokens = 0;
  for (const f of files) {
    const text = decodeUtf8(f.content);
    if (text !== undefined) textTokens += estimateTokens(text);
  }

  const pkg: SkillPackage = {
    id: sourceQualifiedId(origin, name),
    version,
    category,
    capabilities,
    detectors: [],
    roles: [],
    dependencies,
    conflicts: [],
    connectors,
    tool_profile: toolProfile,
    risk,
    description,
    instructions: body,
    digest: skillDigest(files),
    files: folders,
  };
  if (license !== undefined) pkg.license = license;
  if (compatibility !== undefined) pkg.compatibility = compatibility;
  if (metadata.length) pkg.metadata = Object.fromEntries(metadata.sort((a, b) => byteCmp(a[0], b[0])));
  if (allowedTools !== undefined) pkg.allowedTools = allowedTools;

  const layout = mf ? "foundry" : fromExtended ? "extended" : fromMetadata ? "metadata" : "plain";
  return {
    ok: true,
    skill: {
      package: pkg,
      extraFiles,
      provenance: {
        schema: 1,
        source: origin.source,
        repository: origin.repository,
        repositoryKey: origin.repositoryKey,
        commit: origin.commit,
        root: skill.root,
        name,
        layout,
        versionDeclared: rawVersion !== undefined,
        dependencies: depNames,
        technologies,
        requiredTools: [...toolNames].sort(byteCmp),
        entryPoints: { instructions: SKILL_MD, scripts, documents },
        context: { instructions: skillContextTokens(pkg), text: textTokens },
        upstream: sortedUpstream,
      },
    },
  };
}

const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");

/** Normalizes every skill of a prepared import. A skill that fails is quarantined; the others are still normalized. */
export function normalizeImport(prep: { record: ImportRecord; files: ReadonlyMap<string, Uint8Array> }): { skills: NormalizedSkill[]; report: NormalizationReport } {
  const { record } = prep;
  const origin: NormalizeOrigin = { source: record.source, repository: record.repository, repositoryKey: record.repositoryKey, commit: record.commit };
  const rejected: RejectedSkill[] = record.rejected.map((r) => ({ root: r.root, reasons: [...r.reasons] }));
  const reject = (root: string, reasons: string[]) => rejected.push({ root: shownValue(root), reasons: boundReasons(reasons) });

  const ok: NormalizedSkill[] = [];
  for (const entry of record.skills) {
    const files: { path: string; content: Uint8Array }[] = [];
    for (const [path, content] of prep.files) {
      if (inside(entry.root, path)) files.push({ path: entry.root === "." ? path : path.slice(entry.root.length + 1), content });
    }
    let result: NormalizeResult;
    try {
      result = normalizeSkill(origin, { root: entry.root, files });
    } catch {
      reject(entry.root, ["could not be normalized"]);
      continue;
    }
    if (!result.ok) reject(entry.root, result.reasons);
    else if (result.skill.package.digest !== entry.digest) reject(entry.root, ["the files do not match the digest of the import record"]);
    else ok.push(result.skill);
  }

  const group = (list: NormalizedSkill[], key: (s: NormalizedSkill) => string, reason: string): NormalizedSkill[] => {
    const count = new Map<string, number>();
    for (const s of list) count.set(key(s), (count.get(key(s)) ?? 0) + 1);
    const keep: NormalizedSkill[] = [];
    for (const s of list) {
      if ((count.get(key(s)) ?? 0) > 1) reject(s.provenance.root, [reason]);
      else keep.push(s);
    }
    return keep;
  };
  const byName = group(ok, (s) => s.provenance.name, "another skill of this source has the same name");
  const kept = group(byName, (s) => s.package.id, "another skill has the same id");

  const skills = kept.sort((a, b) => byteCmp(a.package.id, b.package.id));
  const normalized = skills.map((s) => ({
    root: s.provenance.root,
    id: s.package.id,
    name: s.provenance.name,
    version: s.package.version,
    digest: s.package.digest,
    layout: s.provenance.layout,
  }));
  return { skills, report: buildReport(origin, normalized, rejected) };
}
