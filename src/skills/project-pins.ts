import { lstatSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { localGit } from "../engine/local-git.js";
import { BRANCH_RE, CHOICE_LIMITS, DEFAULT_BRANCH_HEAD, PINS_FILE } from "./choice-rules.js";
import { parseProjectPins, parseSkillOverrides, type SkillChoice, type SkillOverride } from "./choices.js";
import { readRegular } from "./package.js";
import type { SourceProblem } from "./sources.js";

// Reads the choice files. The project pins come from the default branch through git plumbing, never from the work tree, so a
// work branch cannot pin its own skills. Never throws.

export type ChoiceFileRead<T> = { state: "none" } | { state: "invalid"; problems: SourceProblem[] } | { state: "ok"; items: T[] };

const bad = (message: string): { state: "invalid"; problems: SourceProblem[] } => ({ state: "invalid", problems: [{ where: "file", message }] });

function parseDoc(text: string): { doc: unknown } | { error: string } {
  try {
    return { doc: parseYaml(text, { maxAliasCount: 0 }) };
  } catch {
    return { error: "is not valid YAML" };
  }
}

/** A file in the work tree, for the check commands: no links, size limit, no YAML aliases. */
export function readChoiceFile(path: string, kind: "project-pins"): ChoiceFileRead<SkillChoice>;
export function readChoiceFile(path: string, kind: "overrides"): ChoiceFileRead<SkillOverride>;
export function readChoiceFile(path: string, kind: "project-pins" | "overrides"): ChoiceFileRead<SkillChoice> | ChoiceFileRead<SkillOverride> {
  try {
    lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { state: "none" } : bad("cannot be read");
  }
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, CHOICE_LIMITS.bytes);
  } catch {
    return bad("cannot be read");
  }
  if (data === "link") return bad("is a symbolic link");
  if (data === "other") return bad("is not a readable regular file");
  if (data === "large") return bad(`is larger than ${CHOICE_LIMITS.bytes} bytes`);
  const d = parseDoc(Buffer.from(data).toString("utf8"));
  if ("error" in d) return bad(d.error);
  const r = kind === "overrides" ? parseSkillOverrides(d.doc) : parseProjectPins(d.doc);
  return r.ok ? ({ state: "ok", items: r.items } as ChoiceFileRead<SkillChoice>) : { state: "invalid", problems: r.problems };
}

export type ProjectPinsRead =
  | { state: "none"; source: { commit: string } }
  | { state: "ok"; items: SkillChoice[]; source: { commit: string; blob: string } }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "unreadable"; why: "no-default-branch" | "git-failed" };
export type GitRun = (args: readonly string[]) => { status: number | null; stdout: Buffer };

const defaultGit = (workdir: string): GitRun => localGit(workdir, { timeoutMs: CHOICE_LIMITS.gitMs, maxBytes: CHOICE_LIMITS.bytes + 4096 });

const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const failed = (): ProjectPinsRead => ({ state: "unreadable", why: "git-failed" });
const noBranch = (): ProjectPinsRead => ({ state: "unreadable", why: "no-default-branch" });

/** The project pins of the default branch. Never reads the work tree. Never throws. */
export function readProjectPins(workdir: string, deps: { git?: GitRun; defaultBranch?: string } = {}): ProjectPinsRead {
  try {
    const git = deps.git ?? defaultGit(workdir);
    let branch = deps.defaultBranch;
    if (branch !== undefined) {
      if (!BRANCH_RE.test(branch) || branch.includes("..")) return noBranch();
    } else {
      const s = git(["symbolic-ref", "--quiet", DEFAULT_BRANCH_HEAD]);
      if (s.status === 1) return noBranch();
      if (s.status !== 0) return failed();
      const prefix = "refs/remotes/origin/";
      const out = s.stdout.toString("utf8").trim();
      branch = out.startsWith(prefix) ? out.slice(prefix.length) : undefined;
      if (branch === undefined || !BRANCH_RE.test(branch) || branch.includes("..")) return failed();
    }
    const rp = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
    if (rp.status === 1) return noBranch();
    const commit = rp.stdout.toString("utf8").trim();
    if (rp.status !== 0 || !HASH_RE.test(commit)) return failed();
    const ls = git(["ls-tree", "-z", commit, "--", PINS_FILE]);
    if (ls.status !== 0) return failed();
    const line = ls.stdout.toString("utf8").split("\0")[0] ?? "";
    if (!line) return { state: "none", source: { commit } };
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(line);
    if (!m) return failed();
    if (m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) return bad("is not a regular file");
    const blob = m[3]!;
    const size = git(["cat-file", "-s", blob]);
    if (size.status !== 0) return failed();
    const n = Number(size.stdout.toString("utf8").trim());
    if (!Number.isInteger(n) || n < 0) return failed();
    if (n > CHOICE_LIMITS.bytes) return bad(`is larger than ${CHOICE_LIMITS.bytes} bytes`);
    const body = git(["cat-file", "blob", blob]);
    if (body.status !== 0) return failed();
    const d = parseDoc(body.stdout.toString("utf8"));
    if ("error" in d) return bad(d.error);
    const r = parseProjectPins(d.doc);
    return r.ok ? { state: "ok", items: r.items, source: { commit, blob } } : { state: "invalid", problems: r.problems };
  } catch {
    return failed();
  }
}
