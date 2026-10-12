import { csrfToken } from "../auth/sessions.js";
import type { CliSession } from "./session.js";

/** What the server answered when it refused a call. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null; getSetCookie?(): string[] }; text(): Promise<string> }>;

export interface Call { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown }

/** "/api/" + path + query, with every part encoded. `path` has no leading slash. */
export function apiUrl(server: string, path: string, query: Record<string, string | undefined> = {}): string {
  const q = Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined);
  return `${server}/api/${path.split("/").map(encodeURIComponent).join("/")}${q.length ? `?${new URLSearchParams(q)}` : ""}`;
}

const NOT_RUNNING = (server: string) => `the Foundry at ${server} does not answer; start it (scf serve) or name another one with --server`;

/** One call to the server's API. With a session it sends the session cookie and, for a call that changes something, the CSRF token. */
export async function call(server: string, session: CliSession | undefined, c: Call, fetcher: Fetch = fetch as unknown as Fetch): Promise<{ data: unknown; setCookie: string[] }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (session) {
    headers.cookie = `${session.cookie}=${session.token}`;
    if (c.method !== "GET") headers["x-csrf-token"] = csrfToken(session.token);
  }
  let body: string | undefined;
  if (c.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.body);
  }
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetcher(apiUrl(server, c.path, c.query), { method: c.method, headers, ...(body !== undefined ? { body } : {}) });
  } catch {
    throw new Error(NOT_RUNNING(server));
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: kept as text
  }
  if (res.status >= 400) {
    const said = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `the server answered ${res.status}`;
    const hint = res.status === 401 ? " — sign in first: scf login" : res.status === 404 && !session ? " — sign in first: scf login" : "";
    throw new ApiError(res.status, /scf login|sign in first/i.test(said) ? `${said}: scf login` : said + hint, data);
  }
  return { data, setCookie: res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []) };
}
