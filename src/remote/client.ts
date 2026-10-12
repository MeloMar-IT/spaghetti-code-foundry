import { csrfToken } from "../auth/sessions.js";
import type { CliSession } from "./session.js";

/** What the server answered when it refused a call. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect?: "manual"; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null; getSetCookie?(): string[] }; text(): Promise<string>; body?: { cancel(): Promise<void> } | null }>;

export interface Call {
  method: string;
  /** The path after "/api/", without a leading slash and already encoded: each part once, by whoever built it. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** How long the server may take, in milliseconds. Default: two minutes. */
  timeoutMs?: number;
}

export const TIMEOUT_MS = 120_000;
export const LOGIN_TIMEOUT_MS = 30_000;

/** "/api/" + path + query. `path` has no leading slash and is encoded already; it is sent as it is, never encoded again. */
export function apiUrl(server: string, path: string, query: Record<string, string | undefined> = {}): string {
  const q = Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined);
  const url = `${server}/api/${path}${q.length ? `?${new URLSearchParams(q)}` : ""}`;
  // what is sent must be the path that was asked for: no "..", no second question mark, nothing the URL rules rewrite
  if (new URL(url).pathname !== `/api/${path}`) throw new Error(`"${path}" is not a path of the API`);
  return url;
}

const NOT_RUNNING = (server: string) => `the Foundry at ${server} does not answer; start it (scf serve) or name another one with --server`;
const NOT_A_FOUNDRY = (server: string) => `this does not look like a Foundry server: ${server} did not answer with JSON; check the address (--server)`;

const isJson = (type: string) => /^application\/([\w.-]+\+)?json\b/.test(type);
/** The first line of a plain-text answer, at most 200 characters; nothing for a page of HTML. */
function firstLine(text: string, type: string): string {
  const line = (text.trim().split(/\r?\n/, 1)[0] ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (!line || /html/.test(type) || line.startsWith("<")) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * One call to the server's API. With a session it sends the session cookie and, for a call that changes something,
 * the CSRF token. A redirect is never followed: the body (at sign-in: the password) would go to another address.
 */
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
  const url = apiUrl(server, c.path, c.query);
  const timeoutMs = c.timeoutMs ?? TIMEOUT_MS;
  const late = () => new Error(`the Foundry at ${server} did not answer within ${Math.round(timeoutMs / 1000)} seconds; the call may still be going on there`);
  const failed = (e: unknown) => ((e as { name?: string } | undefined)?.name === "TimeoutError" ? late() : new Error(NOT_RUNNING(server)));
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetcher(url, { method: c.method, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...(body !== undefined ? { body } : {}) });
  } catch (e) {
    throw failed(e);
  }
  const drop = () => void res.body?.cancel().catch(() => undefined);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (res.status >= 300 && res.status < 400) {
    drop();
    const to = res.headers.get("location");
    throw new ApiError(res.status, `${server} sends this call on to ${to ? `"${to.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200)}"` : "another address"} (a redirect): it was not followed, nothing was sent there. If the Foundry is at that address, name it with --server.`);
  }
  if (type.startsWith("text/event-stream")) {
    drop();
    throw new ApiError(res.status, "this call answers with a live stream that does not end: the command line cannot follow a live stream");
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw failed(e);
  }
  let data: unknown = text;
  let parsed = false;
  try {
    data = text ? JSON.parse(text) : undefined;
    parsed = true;
  } catch {
    // not JSON: kept as text
  }
  if (res.status >= 400) {
    const plain = parsed ? "" : firstLine(text, type);
    const said = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `the server answered ${res.status}${plain ? `: ${plain}` : ""}`;
    // the answer to a sign-in is about the e-mail address and the password: "sign in first" would say nothing
    const signIn = c.method === "POST" && c.path === "session";
    const hint = signIn ? "" : res.status === 401 ? " — sign in first: scf login" : res.status === 404 && !session ? " — sign in first: scf login" : "";
    throw new ApiError(res.status, !signIn && /scf login|sign in first/i.test(said) ? `${said}: scf login` : said + hint, data);
  }
  // an answer that is not the API's own is no success, whatever its status: JSON, or the CSV of the audit export
  const csv = type.startsWith("text/csv") && c.path === "audit/export";
  if (!csv && !(isJson(type) && parsed)) throw new ApiError(res.status, NOT_A_FOUNDRY(server), text.slice(0, 200));
  return { data: csv ? text : data, setCookie: res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []) };
}
