import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_KEY_VARS, providerKeyVars } from "../agents/targets.js";
import type { Config } from "../config.js";
import { tokenVarNames } from "../engine/isolation.js";
import type { Build } from "./recipe.js";

export interface Host {
  platform: string;
  arch: string;
}

/** The machine's platform (macos, linux, windows) and arch (arm64, x64). `FACTORY_TEST_RELEASE_HOST=<platform>-<arch>` overrides both, for tests. */
export function hostOf(env: NodeJS.ProcessEnv = process.env): Host {
  const fake = /^([a-z]+)-([a-z0-9]+)$/.exec(env.FACTORY_TEST_RELEASE_HOST ?? "");
  if (fake) return { platform: fake[1]!, arch: fake[2]! };
  const p = process.platform;
  return { platform: p === "darwin" ? "macos" : p === "win32" ? "windows" : p, arch: process.arch };
}

/** Does the build fit this machine? `why` is the summary text for a build that is skipped. */
export function matchBuild(b: Pick<Build, "on" | "arch">, host: Host): { ok: true } | { ok: false; why: string } {
  if (!b.on.includes(host.platform as never)) return { ok: false, why: `needs ${b.on.join(" or ")}` };
  if (b.arch && b.arch !== host.arch) return { ok: false, why: `needs ${b.arch}` };
  return { ok: true };
}

/** Toolchain variables a build may inherit. Never a name that looks like a secret (see SECRET_NAME). */
export const TOOLCHAIN_VARS: readonly string[] = [
  "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL", "TERM",
  "JAVA_HOME", "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME", "NVM_DIR",
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_NDK_HOME", "PYENV_ROOT", "DEVELOPER_DIR", "SDKROOT",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
];

const SECRET_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|_KEY|AUTH/i;
const NUMERIC_VARS = ["FACTORY_VAR_TEST_SLOTS", "FACTORY_TEST_SLOT_WAIT_SEC", "FACTORY_TEST_SLOT_POLL_MS", "FACTORY_TEST_NICE"];

/** Names that never reach a build: the GitHub token variables (also the bot's own) and the provider key variables. */
export function deniedNames(config?: Pick<Config, "bot" | "providers">): Set<string> {
  const names = new Set<string>(tokenVarNames({ bot: { gh_token_env: "" } } as Pick<Config, "bot">));
  if (config) {
    for (const n of tokenVarNames(config)) names.add(n);
    for (const n of providerKeyVars(config)) names.add(n);
  } else {
    for (const n of KNOWN_KEY_VARS) names.add(n);
  }
  return names;
}

export interface ReleaseVars {
  version: string;
  tag: string;
  sha: string;
  inDir: string;
  outDir: string;
}

/** The whole environment of a build or assemble command: PATH, HOME, LANG, the toolchain list and the five FACTORY_RELEASE_* variables. */
export function buildEnv(source: NodeJS.ProcessEnv, r: ReleaseVars, denied: Set<string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", ...TOOLCHAIN_VARS]) {
    const v = source[name];
    if (v === undefined || denied.has(name) || SECRET_NAME.test(name)) continue;
    if (/^https?_proxy$/i.test(name) && /:\/\/[^/]*@/.test(v)) continue;
    env[name] = v;
  }
  for (const name of NUMERIC_VARS) {
    const v = source[name];
    if (v !== undefined && /^\d+$/.test(v) && !denied.has(name)) env[name] = v;
  }
  return {
    ...env,
    FACTORY_RELEASE_VERSION: r.version,
    FACTORY_RELEASE_TAG: r.tag,
    FACTORY_RELEASE_IN: r.inDir,
    FACTORY_RELEASE_OUT: r.outDir,
    FACTORY_RELEASE_SHA: r.sha,
  };
}

/** Is `name` an executable file in a folder of `pathVar`? No shell. */
export function findCommand(name: string, pathVar: string, platform: string = process.platform): boolean {
  const win = platform === "win32";
  const exts = win ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  for (const dir of pathVar.split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, win ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

/** Send a signal to a process and everything it started: its process group, or taskkill /T on Windows (no group there). */
export function killTree(pid: number, sig: NodeJS.Signals, platform: string = process.platform, run: typeof execFileSync = execFileSync): void {
  try {
    if (platform === "win32") run("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, sig);
  } catch {
    /* already gone */
  }
}

/** Is any process of the group still there? (POSIX) */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
