import { isMap, isSeq, parse as parseYaml, parseDocument, stringify, type YAMLMap } from "yaml";
import { ConfigSchema, type Config } from "../config.js";
import { catalogueChangesMarkdown, type CatalogueChanges } from "./release-changes.js";
import { applySplices, contentEnd, lineEnd, lineStart, pairOf, PULL_REQUEST_BYTES, rangeOf } from "./source-update.js";

// The text of a release proposal: the branch name, the byte-exact append of one approved entry to the deployment config, the proof
// that nothing else changed, and the pull-request text. Pure: no file, no process, no clock. The YAML is never re-rendered: one new
// piece of text is spliced in, so comments and every other byte stay.

export interface DeploymentEntry {
  catalogue: string;
  version: string;
  digest: string;
  key?: string;
  signature?: string;
}

export const releaseBranch = (catalogue: string, version: string): string => `skill-catalogue/${catalogue}-${version}`;

/** owner/name for github.com, else host/owner/name, lower-case; for comparing the address of origin with the config. */
export function normalRepository(r: string): string {
  const s = r.toLowerCase();
  return s.startsWith("github.com/") ? s.slice("github.com/".length) : s;
}

const CANNOT = "the deployment file has a form this command cannot edit byte for byte";
const PATH = ["skills", "releases", "approved"] as const;

const plainOf = (e: DeploymentEntry): Record<string, string> => ({
  catalogue: e.catalogue,
  version: e.version,
  digest: e.digest,
  ...(e.key !== undefined ? { key: e.key } : {}),
  ...(e.signature !== undefined ? { signature: e.signature } : {}),
});

/** The YAML of `value` as lines, each indented by `indent` spaces. */
const rendered = (value: unknown, indent: number): string[] =>
  stringify(value, { lineWidth: 0 })
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => " ".repeat(indent) + l);

/** The end of the line a node ends on. A range that already includes its final newline (a block scalar) ends on the line before. */
const insertAt = (text: string, end: number): number => (end > 0 && text[end - 1] === "\n" ? end - 1 : lineEnd(text, end));

/** Appends one entry to skills.releases.approved; creates the missing keys of that path. Every other byte stays. */
export function appendApprovedEntry(text: string, entry: DeploymentEntry): { text: string } | { problem: string } {
  const plain = plainOf(entry);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { problem: CANNOT };
  const nested = (from: number): unknown => PATH.slice(from).reduceRight<unknown>((inner, k) => ({ [k]: inner }), [plain]);

  if (doc.contents === null) {
    const lead = text === "" || text.endsWith("\n") ? "" : "\n";
    return { text: text + lead + rendered(nested(0), 0).join("\n") + "\n" };
  }
  if (!isMap(doc.contents) || doc.contents.flow) return { problem: CANNOT };

  let map: YAMLMap = doc.contents;
  for (let i = 0; i < PATH.length; i++) {
    if (map.items.length === 0) return { problem: CANNOT };
    const pair = pairOf(map, PATH[i]!);
    if (!pair) {
      const firstAt = rangeOf(map.items[0]!.key)?.[0];
      const last = map.items.at(-1)!;
      const end = contentEnd(last.value) ?? rangeOf(last.key)?.[1];
      if (firstAt === undefined || end === undefined) return { problem: CANNOT };
      const before = text.slice(lineStart(text, firstAt), firstAt);
      if (!/^ *$/.test(before)) return { problem: CANNOT };
      const at = insertAt(text, end);
      return { text: applySplices(text, [{ start: at, end: at, text: "\n" + rendered(nested(i), before.length).join("\n") }]) };
    }
    if (i < PATH.length - 1) {
      if (!isMap(pair.value) || pair.value.flow) return { problem: CANNOT };
      map = pair.value;
      continue;
    }
    const seq = pair.value;
    if (!isSeq(seq)) return { problem: CANNOT };
    const range = rangeOf(seq);
    if (!range) return { problem: CANNOT };
    const last = seq.items.at(-1);
    if (seq.flow) {
      if (!last) return { text: applySplices(text, [{ start: range[0] + 1, end: range[0] + 1, text: JSON.stringify(plain) }]) };
      const end = rangeOf(last)?.[1];
      if (end === undefined) return { problem: CANNOT };
      return { text: applySplices(text, [{ start: end, end, text: `, ${JSON.stringify(plain)}` }]) };
    }
    const firstAt = rangeOf(seq.items[0])?.[0];
    const end = contentEnd(last);
    if (firstAt === undefined || end === undefined) return { problem: CANNOT };
    const before = text.slice(lineStart(text, firstAt), firstAt);
    if (!/^ *- *$/.test(before)) return { problem: CANNOT };
    const at = insertAt(text, end);
    return { text: applySplices(text, [{ start: at, end: at, text: "\n" + rendered([plain], before.indexOf("-")).join("\n") }]) };
  }
  return { problem: CANNOT };
}

/** Deep equality of parsed YAML (plain objects, arrays, scalars); key order does not matter. */
function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => isDeepStrictEqual(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && isDeepStrictEqual(a[k], b[k]));
  }
  return Object.is(a, b);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Proves the edit: a single insertion, valid YAML, a valid config, and the old config with only the new entry appended. */
export function checkApprovedEdit(before: string, after: string, entry: DeploymentEntry): { ok: true; config: Config } | { problem: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  if (!(after.length > before.length && p + s === before.length)) return { problem: "the edit would change other bytes of the deployment file" };

  let afterRaw: unknown;
  let beforeRaw: unknown;
  try {
    afterRaw = parseYaml(after);
    beforeRaw = parseYaml(before);
  } catch {
    return { problem: "the edited deployment file is not valid YAML" };
  }
  const parsed = ConfigSchema.safeParse(afterRaw ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return { problem: `the edited deployment file is not a valid config: ${i.path.join(".")}: ${i.message}` };
  }

  const expected: unknown = structuredClone(beforeRaw ?? {});
  const changed = "the edit would change another setting of the deployment file";
  if (!isObject(expected)) return { problem: changed };
  let at: Record<string, unknown> = expected;
  for (const k of PATH.slice(0, 2)) {
    const next = at[k] ?? {};
    if (!isObject(next)) return { problem: changed };
    at[k] = next;
    at = next;
  }
  const old = at.approved ?? [];
  if (!Array.isArray(old)) return { problem: changed };
  at.approved = [...old, plainOf(entry)];
  if (!isDeepStrictEqual(expected, afterRaw)) return { problem: changed };
  return { ok: true, config: parsed.data };
}

export interface ReleaseProposalInput {
  file: string;
  entry: DeploymentEntry;
  signedBy?: string;
  previous?: { version: string; digest: string };
  changes: CatalogueChanges;
}

const code = (s: string): string => "`" + s.replace(/<!--/g, "<!- -").replace(/`/g, "'") + "`";

/** The title and body of the pull request. The body is at most PULL_REQUEST_BYTES. */
export function releasePullRequest(i: ReleaseProposalInput): { title: string; body: string } {
  const { catalogue, version, digest } = i.entry;
  const name = `${catalogue}@${version}`;
  const head = [
    `## Skill catalogue release: ${code(catalogue)} ${code(version)}`,
    "",
    `- Digest: ${code(digest)}`,
    `- Signed by: ${i.signedBy !== undefined ? code(i.signedBy) : "not signed"}`,
    `- Previous approved version: ${i.previous ? `${code(i.previous.version)} (${code(i.previous.digest)})` : "none"}`,
    `- File: ${code(i.file)}`,
    "",
    `This pull request adds one entry to ${code("skills.releases.approved")} in ${code(i.file)} and keeps the older entries, so runs locked to them keep working. An installation uses the release only after its config names it; run ${code(`scf skills release adopt ${name}`)} after the merge if the release is not in its store.`,
    "",
  ].join("\n");
  const body = head + "\n" + catalogueChangesMarkdown(i.changes, { bytes: PULL_REQUEST_BYTES - Buffer.byteLength(head) - 100 });
  return { title: `Skill catalogue ${catalogue}: approve ${version}`, body };
}
