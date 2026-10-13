import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  // Created closed: the token is never readable by others, not even for a moment. A new file beside the old one
  // ("wx" fails when the name is taken, also by a link), then moved over it: an old file with open rights or a
  // link at this path is replaced, never written through.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const clearSession = (path = sessionFile()) => rmSync(path, { force: true });

/** This machine: "localhost", 127.0.0.0/8 and [::1]. Only there is plain http safe for a password. */
const isLocal = (host: string) => host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * "localhost:4777/" → "http://localhost:4777", "foundry.example.com" → "https://foundry.example.com".
 * Only http and https, and no path, user name or query. Plain http only for this machine: anything else is
 * reached over HTTPS, so the password and the session never travel in clear text.
 */
export function serverUrl(text: string): string {
  const notOne = () => new Error(`"${text}" is not a server address; use one like ${DEFAULT_SERVER}`);
  const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let u: URL;
  try {
    u = new URL(typed ? text : `http://${text}`);
    if (!typed && !isLocal(u.hostname)) u = new URL(`https://${text}`);
  } catch {
    throw notOne();
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw notOne();
  if (u.protocol === "http:" && !isLocal(u.hostname)) {
    throw new Error(`"${text}" is plain http: a Foundry on another machine must be reached over HTTPS, or the password and the session travel in clear text. Use https://${u.host}`);
  }
  return u.origin;
}
