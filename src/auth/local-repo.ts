import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { RepoError } from "./repo-url.js";
import { dataHome } from "./store.js";

/** A local repository is known by this string, never by a GitHub `owner/name`. */
export const LOCAL_NAME_RE = /^local:[a-z0-9][a-z0-9._-]{0,39}-[0-9a-f]{8}$/;
export const isLocalRepoName = (name: string): boolean => typeof name === "string" && LOCAL_NAME_RE.test(name);

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PATH_MAX = 1000;

/** `local:<slug>-<first 8 hex of the record id>`. */
export function localRepoName(rec: { id: string; url: string }): string {
  let slug = basename(rec.url)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40);
  if (!slug) slug = "repo";
  return "local:" + slug + "-" + rec.id.slice(0, 8).toLowerCase();
}

/** The pure rules for a stored path (no filesystem, so a record still reads when its folder is gone). */
export function localPathProblem(url: string): string | undefined {
  if (CONTROL.test(url)) return "has a control character";
  if (url.length > PATH_MAX) return "is longer than " + PATH_MAX + " characters";
  if (!isAbsolute(url)) return "is not absolute";
  if (resolve(url) !== url) return "is not normalised";
  return undefined;
}

const bad = (m: string) => new RepoError("bad-url", m);

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return Object.assign(env, { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Checks a folder for adding it. Returns its canonical (real) path. Throws RepoError("bad-url"). */
export function checkLocalPath(input: unknown, o: { home?: string; git?: string } = {}): string {
  if (typeof input !== "string") throw bad("give the absolute path of a git repository on this machine");
  if (CONTROL.test(input)) throw bad("the path has a control character");
  const given = input.trim();
  if (!given) throw bad("give the absolute path of a git repository on this machine");
  if (!isAbsolute(given)) throw bad("the path must be absolute (start with /)");
  let st;
  try {
    st = statSync(given);
  } catch {
    throw bad("there is no folder at that path");
  }
  if (!st.isDirectory()) throw bad("that path is not a folder");
  let p: string;
  try {
    p = realpathSync(given);
  } catch {
    throw bad("there is no folder at that path");
  }
  const home = realOrResolved(o.home ?? dataHome());
  if (p === home || p.startsWith(home.endsWith(sep) ? home : home + sep)) throw bad("that path is inside the Foundry data folder");
  const r = spawnSync(o.git ?? "git", ["-c", "core.fsmonitor=false", "-C", p, "rev-parse", "--show-toplevel"], {
    env: cleanEnv(),
    timeout: 3_000,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw bad("git was not found on the server, so the path cannot be checked");
    throw bad("that path is not a git repository (the check failed)");
  }
  if (r.status !== 0) throw bad("that path is not a git repository");
  let top: string;
  try {
    top = realpathSync(String(r.stdout).trim());
  } catch {
    throw bad("that path is not a git repository");
  }
  if (top !== p) throw bad("that path is not the top folder of a git repository");
  const problem = localPathProblem(p);
  if (problem) throw bad("the path " + problem);
  return p;
}
