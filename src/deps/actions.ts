// GitHub Actions pins for the weekly dependency check. tools/deps-weekly actions reads the workflow files (no code runs), asks `gh` for the newest
// release of each action and writes actions.json; the check step reads that file. Pure logic and validation only.
import { parseDocument, isMap, isScalar, isSeq } from "yaml";
import { isObj, type ToolRun } from "./ecosystems.js";

export const ACTIONS_MAX = 100;
export const WORKFLOW_FILES_MAX = 200;
export const WORKFLOW_BYTES_MAX = 1024 * 1024;
export const ACTIONS_FILE_MAX = 4 * 1024 * 1024;
export const GH_TIMEOUT_MS = 20_000;
export const ACTIONS_DEADLINE_MS = 5 * 60_000;
export const ACTIONS_LOST_NOTE = "the lookup result could not be read; GitHub Actions were not checked";

export interface ActionPin { name: string; repo: string; ref: string; comment?: string }
export interface ActionsFile {
  version: 1; workflows: number; pins: ActionPin[];
  releases: Record<string, string>; releaseShas: Record<string, string>;
  noRelease: string[]; failed: string[]; invalid: number; note?: string;
}

const USES = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})((?:\/[A-Za-z0-9._-]{1,100}){0,8})@([A-Za-z0-9._/-]{1,100})$/;
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const COMMENT_VERSION = /(?:^|[^A-Za-z0-9.])(v?\d+(?:\.\d+){0,2})(?![A-Za-z0-9.])/;
const dots = (s: string) => s.split("/").some((p) => p === "." || p === "..");

export const isSha = (ref: string) => SHA.test(ref);
export const isOwnerRepo = (s: string) => OWNER_REPO.test(s) && !dots(s);
export const isTag = (s: string) => TAG.test(s);

/** The version in the comment after a pin ("# v4.1.1"); undefined when there is none. */
function commentVersion(text: string | undefined | null): string | undefined {
  return COMMENT_VERSION.exec(String(text ?? ""))?.[1];
}

function parseUses(value: unknown, comment: string | undefined): ActionPin | undefined {
  if (typeof value !== "string") return undefined;
  const m = USES.exec(value);
  if (!m || dots(m[2]!) || dots(m[3] ?? "")) return undefined;
  const repo = `${m[1]}/${m[2]}`;
  const pin: ActionPin = { name: `${repo}${m[3] ?? ""}`, repo, ref: m[4]! };
  if (comment) pin.comment = comment;
  return pin;
}

/** Every `uses: owner/repo[/path]@ref` of jobs.<job>.steps[] and jobs.<job>.uses; `run:` text and local or docker uses are ignored. */
export function parseWorkflows(texts: string[]): { pins: ActionPin[]; invalid: number } {
  const pins: ActionPin[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const text of texts) {
    const doc = parseDocument(text, { uniqueKeys: false });
    if (doc.errors.length > 0) {
      invalid++;
      continue;
    }
    const add = (map: unknown) => {
      if (!isMap(map)) return;
      const node = map.get("uses", true);
      if (!isScalar(node)) return;
      // The comment after the value: from the source line first (any style), else from the YAML comment fields.
      const end = node.range?.[1];
      let tail: string | undefined;
      if (end !== undefined) {
        const rest = text.slice(end, text.indexOf("\n", end) < 0 ? undefined : text.indexOf("\n", end));
        tail = /^[ \t]*#(.*)$/.exec(rest)?.[1];
      }
      const pin = parseUses(node.value, commentVersion(tail) ?? commentVersion(node.comment));
      if (!pin) return;
      const key = `${pin.name}@${pin.ref}#${pin.comment ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      pins.push(pin);
    };
    const jobs = doc.get("jobs");
    if (!isMap(jobs)) continue;
    for (const pair of jobs.items) {
      const job = pair.value;
      if (!isMap(job)) continue;
      add(job);
      const steps = job.get("steps");
      if (isSeq(steps)) for (const s of steps.items) add(s);
    }
  }
  return { pins, invalid };
}

export type Lookup<T> = { kind: "ok"; value: T } | { kind: "none" } | { kind: "failed" };

/** The tag of `gh api repos/<repo>/releases/latest`: 404 means the action has no release. */
export function releaseFromGh(r: ToolRun): Lookup<string> {
  if (r.error || r.status !== 0) return !r.error && /\b404\b|Not Found/i.test(r.stderr ?? "") ? { kind: "none" } : { kind: "failed" };
  try {
    const j: unknown = JSON.parse(String(r.stdout ?? ""));
    if (isObj(j) && typeof j.tag_name === "string" && TAG.test(j.tag_name)) return { kind: "ok", value: j.tag_name };
  } catch {
    // not JSON: a failed lookup
  }
  return { kind: "failed" };
}

/** The commit of a tag (`gh api repos/<repo>/commits/<tag> --jq .sha`); undefined when it is not a full commit id. */
export function commitFromGh(r: ToolRun): string | undefined {
  if (r.error || r.status !== 0) return undefined;
  const s = String(r.stdout ?? "").trim();
  return SHA.test(s) ? s : undefined;
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** The text of actions.json checked field by field; undefined when it is not a valid file. */
export function readActionsFile(text: string): ActionsFile | undefined {
  if (text.length > ACTIONS_FILE_MAX) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(j) || j.version !== 1 || !Array.isArray(j.pins) || j.pins.length > 5000) return undefined;
  const pins: ActionPin[] = [];
  for (const p of j.pins) {
    if (!isObj(p) || !str(p.name, 400) || !str(p.repo, 200) || !str(p.ref, 100) || !isOwnerRepo(p.repo) || !p.name.startsWith(p.repo)) return undefined;
    if (!USES.test(`${p.name}@${p.ref}`)) return undefined;
    if (p.comment !== undefined && (!str(p.comment, 40) || !/^v?\d+(\.\d+){0,2}$/.test(p.comment))) return undefined;
    pins.push({ name: p.name, repo: p.repo, ref: p.ref, ...(p.comment ? { comment: p.comment } : {}) });
  }
  const map = (v: unknown, ok: (s: string) => boolean): Record<string, string> | undefined => {
    if (!isObj(v) || Object.keys(v).length > 1000) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!isOwnerRepo(k) || typeof val !== "string" || !ok(val)) return undefined;
      out[k] = val;
    }
    return out;
  };
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === "string" && isOwnerRepo(x)) ? (v as string[]) : undefined;
  const releases = map(j.releases, isTag);
  const releaseShas = map(j.releaseShas, isSha);
  const noRelease = list(j.noRelease);
  const failed = list(j.failed);
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : undefined);
  const workflows = count(j.workflows);
  const invalid = count(j.invalid);
  if (!releases || !releaseShas || !noRelease || !failed || workflows === undefined || invalid === undefined) return undefined;
  return { version: 1, workflows, pins, releases, releaseShas, noRelease, failed, invalid };
}

export function actionsSummary(f: ActionsFile): string {
  const repos = new Set(f.pins.map((p) => p.repo)).size;
  return `Actions: ${f.pins.length} pin${f.pins.length === 1 ? "" : "s"} of ${repos} action${repos === 1 ? "" : "s"} in ${f.workflows} workflow file${f.workflows === 1 ? "" : "s"}; ${Object.keys(f.releases).length} newest releases found, ${f.failed.length} lookups failed.`;
}
