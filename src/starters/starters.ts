import { execFile } from "node:child_process";
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_COMMAND } from "../auth/repo-settings.js";
import { dataHome } from "../auth/store.js";
import { STARTER_ID_RE } from "../config.js";
import { parsePreview } from "../preview/config.js";
import { parseRecipe } from "../release/recipe.js";

/**
 * Starters: folders with a ready project (`starter.yaml`, `README.md`, `.factory/preview.yaml`, `.factory/release-build.yaml` and
 * the files of the project). Built-in ones are in `starters/`, an admin's own in `<data folder>/starters/<id>/`.
 * `createProject()` copies one into a new git repository (`main` and `develop`) and hands the folder to `connect`.
 */

export const BUILTIN_STARTERS = resolve(dirname(fileURLToPath(import.meta.url)), "../../starters");
export const OWN_STARTERS_DIR = "starters";
export const MAX_STARTER_FILES = 200;
export const MAX_STARTER_BYTES = 2 * 1024 * 1024;
export const MAX_NAME = 60;
const MAX_DEPTH = 12;
const MAX_META_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 20_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type StarterSource = "built-in" | "own";
export interface Starter {
  id: string;
  title: string;
  description: string;
  needs: string[];
  test: string;
  source: StarterSource;
  /** The folder. Never sent to a client. */
  dir: string;
}
export interface BrokenStarter {
  id: string;
  source: StarterSource;
  problem: string;
}
export interface Catalogue {
  starters: Starter[];
  broken: BrokenStarter[];
}

export type StarterErrorCode = "bad-name" | "bad-folder" | "not-found" | "broken" | "exists" | "failed";
/** `message` is safe to show; `detail` is for the server log only. */
export class StarterError extends Error {
  constructor(
    public code: StarterErrorCode,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "StarterError";
  }
}

const noControl = (s: string) => !CONTROL.test(s);
const StarterFileSchema = z.strictObject({
  title: z.string().trim().min(1).max(60).refine(noControl, "has a control character"),
  description: z.string().trim().min(1).max(300).refine(noControl, "has a control character"),
  test: z.string().trim().min(1).max(MAX_COMMAND).refine(noControl, "has a control character"),
  needs: z.array(z.enum(["node"])).max(5),
});

/** A short, one-line, printable text of an error message. */
function oneLine(message: string): string {
  const lines = message.split("\n");
  const text = lines[1] ? `${lines[0]}: ${lines[1].trim().replace(/^- /, "")}` : (lines[0] ?? "");
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);
}

/** The id as it is shown when it is not a valid id: cut to 40 characters, control characters replaced. */
const shownId = (id: string): string => id.slice(0, 40).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/** The first problem in the tree (a link, a special file, a `.git` entry, too many files or bytes), or undefined. */
function treeProblem(root: string): string | undefined {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return "has folders nested too deep";
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") return "contains git data (.git)";
      const st = lstatSync(join(dir, name));
      if (st.isSymbolicLink()) return "contains a link";
      if (st.isDirectory()) {
        const p = walk(join(dir, name), depth + 1);
        if (p) return p;
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        if (files > MAX_STARTER_FILES) return `has more than ${MAX_STARTER_FILES} files`;
        if (bytes > MAX_STARTER_BYTES) return "is larger than 2 MB";
      } else return "contains a file that is not a plain file";
    }
    return undefined;
  };
  return walk(root, 0);
}

/** The text of a plain file of the starter, or undefined when it is missing or not a plain file. */
function readPlain(dir: string, rel: string): string | undefined {
  try {
    const file = join(dir, rel);
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_META_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Checks one starter folder. Never throws: a problem is a plain sentence. */
export function checkStarter(dir: string, id: string, source: StarterSource): { meta: Starter } | { problem: string } {
  try {
    if (!STARTER_ID_RE.test(id)) return { problem: "the folder name is not a starter id (a-z, 0-9 and -, 1–40 characters)" };
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return { problem: "is a link" };
    if (!st.isDirectory()) return { problem: "is not a folder" };
    const tree = treeProblem(dir);
    if (tree) return { problem: tree };
    const yamlText = readPlain(dir, "starter.yaml");
    if (yamlText === undefined) return { problem: "starter.yaml is missing" };
    let raw: unknown;
    try {
      raw = parse(yamlText);
    } catch {
      return { problem: "starter.yaml is not valid YAML" };
    }
    const res = StarterFileSchema.safeParse(raw);
    if (!res.success) {
      const i = res.error.issues[0];
      return { problem: `starter.yaml is not valid: ${(i?.path.join(".") || "(root)").slice(0, 40)} ${i?.message ?? ""}`.slice(0, 200) };
    }
    if (readPlain(dir, "README.md") === undefined) return { problem: "README.md is missing" };
    const preview = readPlain(dir, ".factory/preview.yaml");
    if (preview === undefined) return { problem: ".factory/preview.yaml is missing" };
    try {
      parsePreview(preview);
    } catch (e) {
      return { problem: oneLine((e as Error).message) };
    }
    const recipe = readPlain(dir, ".factory/release-build.yaml");
    if (recipe === undefined) return { problem: ".factory/release-build.yaml is missing" };
    try {
      parseRecipe(recipe);
    } catch (e) {
      return { problem: oneLine((e as Error).message) };
    }
    return { meta: { id, ...res.data, source, dir } };
  } catch {
    return { problem: "could not be read" };
  }
}

export interface ListOptions {
  hidden?: readonly string[];
  builtinDir?: string;
  ownDir?: string;
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Every usable and every broken starter. An own starter with the id of a built-in replaces it (also a broken one). `hidden`
 * hides built-in starters only. All entries are read; there is no cut-off.
 */
export function listStarters(o: ListOptions = {}): Catalogue {
  const builtinDir = o.builtinDir ?? BUILTIN_STARTERS;
  const ownDir = o.ownDir ?? join(dataHome(), OWN_STARTERS_DIR);
  const hidden = new Set(o.hidden ?? []);
  const starters: Starter[] = [];
  const broken: BrokenStarter[] = [];
  const add = (dir: string, id: string, source: StarterSource) => {
    const r = checkStarter(dir, id, source);
    if ("meta" in r) starters.push(r.meta);
    else broken.push({ id: shownId(id), source, problem: r.problem });
  };
  const ownIds = new Set<string>();
  for (const name of names(ownDir)) {
    if (STARTER_ID_RE.test(name)) ownIds.add(name);
    add(join(ownDir, name), name, "own");
  }
  for (const name of names(builtinDir)) {
    if (ownIds.has(name) || hidden.has(name)) continue;
    let isDir = false;
    try {
      isDir = lstatSync(join(builtinDir, name)).isDirectory();
    } catch {
      // not readable: ignored
    }
    if (isDir) add(join(builtinDir, name), name, "built-in");
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { starters: starters.sort(byId), broken: broken.sort(byId) };
}

/** One usable starter by id. Throws StarterError "not-found" (unknown or hidden) or "broken" (with the problem). */
export function getStarter(id: string, o: ListOptions = {}): Starter {
  if (!STARTER_ID_RE.test(id)) throw new StarterError("not-found", "no such starter");
  const cat = listStarters(o);
  const found = cat.starters.find((s) => s.id === id);
  if (found) return found;
  const bad = cat.broken.find((b) => b.id === id);
  if (bad) throw new StarterError("broken", `this starter cannot be used: ${bad.problem}`);
  throw new StarterError("not-found", "no such starter");
}

// ---- names and folders -----------------------------------------------------------------------------------

/** The name of a new project: text, trimmed, 1–60 characters, no control characters. */
export function projectName(input: unknown): string {
  if (typeof input !== "string") throw new StarterError("bad-name", "give a name for the project");
  const name = input.trim();
  if (!name) throw new StarterError("bad-name", "give a name for the project");
  if (name.length > MAX_NAME) throw new StarterError("bad-name", `the name is longer than ${MAX_NAME} characters`);
  if (CONTROL.test(name)) throw new StarterError("bad-name", "the name has a control character");
  return name;
}

/** The folder name for a project name: lowercase letters and digits (any script) with single dashes, at most 60 characters. */
export function projectSlug(name: string): string {
  const slug = Array.from(
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, MAX_NAME) // by code point, so a character is never cut in half
    .join("")
    .replace(/-+$/, "");
  if (!slug) throw new StarterError("bad-name", "the name needs at least one letter or digit");
  return slug;
}

const bad = (m: string) => new StarterError("bad-folder", m);

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function insideData(p: string): boolean {
  const home = realOrResolved(dataHome());
  return p === home || p.startsWith(home.endsWith(sep) ? home : home + sep);
}

/** The real path of the nearest existing ancestor, with the part that does not exist yet added. Nothing is written. */
function prospective(path: string): { real: string; missing: boolean } {
  const rest: string[] = [];
  let cur = path;
  for (;;) {
    try {
      const real = realpathSync(cur);
      if (!statSync(real).isDirectory()) throw bad("the projects folder is not a folder");
      return { real: rest.length ? join(real, ...rest) : real, missing: rest.length > 0 };
    } catch (e) {
      if (e instanceof StarterError) throw e;
      let exists = true;
      try {
        lstatSync(cur);
      } catch {
        exists = false;
      }
      if (exists) throw bad("the projects folder cannot be used"); // for example a link that leads nowhere
      const up = dirname(cur);
      if (up === cur) throw bad("the projects folder cannot be used");
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * Where the new project goes: the folder, and whether it has to be made. An explicit `parent` must be an existing absolute
 * folder; otherwise `projects_folder` or `<home>/scf-projects`. Nothing is written; a path in the data folder is refused (400).
 */
export function projectParent(simple: { projects_folder?: string }, explicit: unknown, userHome?: string): { dir: string; missing: boolean } {
  let wanted: string;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || CONTROL.test(explicit) || !isAbsolute(explicit.trim())) throw bad("the parent folder must be an absolute path");
    wanted = resolve(explicit.trim());
  } else wanted = resolve(simple.projects_folder ?? join(userHome ?? homedir(), "scf-projects"));
  const given = explicit !== undefined && explicit !== null;
  const p = prospective(wanted);
  if (given && p.missing) throw bad("there is no folder at the parent path");
  if (insideData(p.real)) throw bad("that folder is inside the Foundry data folder");
  return { dir: p.real, missing: p.missing };
}

// ---- git and the copy ------------------------------------------------------------------------------------

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return Object.assign(env, { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
}

function git(bin: string, dir: string, args: string[]): Promise<void> {
  const prefix = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false",
    "-c", "core.excludesFile=/dev/null", // the server account's global ignore rules must not drop starter files
    "-c", "user.name=Spaghetti Code Foundry",
    "-c", "user.email=scf@localhost",
    "-C", dir,
  ];
  return new Promise((done, fail) => {
    const failed = () => fail(new StarterError("failed", "the project could not be made; see the server log", `starters: git ${args[0]} failed`));
    try {
      execFile(bin, [...prefix, ...args], { env: cleanEnv(), timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" }, (err) => (err ? failed() : done()));
    } catch {
      failed();
    }
  });
}

/** Copies the starter. It looks again for links and `.git`: an own folder can change after the check. */
function copyStarter(src: string, dst: string): void {
  let files = 0;
  const changed = () => new StarterError("failed", "the project could not be made; see the server log", "starters: the starter changed while it was copied");
  const walk = (from: string, to: string, top: boolean, depth: number) => {
    if (depth > MAX_DEPTH) throw changed();
    for (const name of readdirSync(from).sort()) {
      if (name === ".git") throw changed();
      const st = lstatSync(join(from, name));
      if (st.isSymbolicLink()) throw changed();
      if (st.isDirectory()) {
        mkdirSync(join(to, name));
        walk(join(from, name), join(to, name), false, depth + 1);
      } else if (st.isFile()) {
        if (top && name === "starter.yaml") continue;
        if (++files > MAX_STARTER_FILES) throw changed();
        copyFileSync(join(from, name), join(to, top && name === "gitignore" ? ".gitignore" : name), constants.COPYFILE_EXCL);
      } else throw changed();
    }
  };
  walk(src, dst, true, 0);
}

export interface CreateOptions<T> {
  starter: Starter;
  name: unknown;
  parent?: unknown;
  simple?: { projects_folder?: string };
  userHome?: string;
  git?: string;
  /** Connects the finished git folder. A throw removes the folder again. */
  connect: (dir: string, starter: Starter) => Promise<T>;
}

/**
 * Makes a project from a starter. The name and the parent are checked before any folder is made; the target is reserved with a
 * non-recursive mkdir (409 when it exists, never overwritten). Any failure after that removes the folder this call made.
 */
export async function createProject<T>(o: CreateOptions<T>): Promise<{ dir: string; slug: string; result: T }> {
  const slug = projectSlug(projectName(o.name));
  const where = projectParent(o.simple ?? {}, o.parent, o.userHome);
  if (where.missing) {
    try {
      mkdirSync(where.dir, { recursive: true });
    } catch {
      throw new StarterError("failed", "the project could not be made; see the server log", "starters: the projects folder could not be made");
    }
    if (insideData(realOrResolved(where.dir))) throw bad("that folder is inside the Foundry data folder");
  }
  const dir = join(realOrResolved(where.dir), slug);
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new StarterError("exists", "a folder with that name exists already; choose another name");
    throw new StarterError("failed", "the project could not be made; see the server log", "starters: the project folder could not be made");
  }
  try {
    copyStarter(o.starter.dir, dir);
    const bin = o.git ?? "git";
    await git(bin, dir, ["init", "-q"]);
    await git(bin, dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(bin, dir, ["add", "--all"]);
    await git(bin, dir, ["commit", "-q", "--no-verify", "-m", `Start from the ${o.starter.title} starter`]);
    await git(bin, dir, ["checkout", "-q", "-b", "develop"]);
    const result = await o.connect(dir, o.starter);
    return { dir, slug, result };
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // the folder stays; the original error is the one to report
    }
    throw e;
  }
}
