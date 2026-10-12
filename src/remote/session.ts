import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";

/** The sign-in of the command line at one server: kept in <data folder>/cli-session.json, readable by this user only. */
export interface CliSession {
  /** The server's address without a trailing slash, e.g. "http://localhost:4777". */
  server: string;
  /** The name of the server's session cookie (it holds the server's port). */
  cookie: string;
  token: string;
  email: string;
}

export const DEFAULT_SERVER = "http://localhost:4777";
export const sessionFile = (home = process.env.FACTORY_HOME ?? FACTORY_HOME) => join(home, "cli-session.json");

export function loadSession(path = sessionFile()): CliSession | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as CliSession;
    return typeof s.server === "string" && typeof s.cookie === "string" && typeof s.token === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(s: CliSession, path = sessionFile()) {
  mkdirSync(dirname(path), { recursive: true });
  // created closed: the token is never readable by others, not even for a moment
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const clearSession = (path = sessionFile()) => rmSync(path, { force: true });

/** "localhost:4777/" → "http://localhost:4777". Only http and https, and no path, user name or query. */
export function serverUrl(text: string): string {
  const u = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new Error(`"${text}" is not a server address; use one like ${DEFAULT_SERVER}`);
  }
  return u.origin;
}
