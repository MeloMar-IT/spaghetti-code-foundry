import { isTemporaryGitHubError } from "./errors.js";

/** Body flags of `gh api`: a call with one of them is a POST unless the method says GET. Covers `-f x`, `-fx=1`, `--field=x`, `--input=-`. */
const BODY_FLAG = /^(?:-[fF][\s\S]*|--(?:field|raw-field|input)(?:=[\s\S]*)?)$/;

/** The method a `gh api` call asks for (upper case), if any. */
function apiMethod(args: readonly string[]): string | undefined {
  let m: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") m = args[++i] ?? "";
    else if (a.startsWith("--method=")) m = a.slice(9);
    else if (a.startsWith("-X")) m = a.slice(2);
  }
  return m?.toUpperCase();
}

/** The text of the GraphQL query a call sends; undefined when it cannot be found, or when two disagree. */
function graphqlQuery(args: readonly string[], input?: string): string | undefined {
  const found: string[] = [];
  if (input !== undefined) {
    try {
      const q = (JSON.parse(input) as { query?: unknown } | null)?.query;
      if (typeof q === "string") found.push(q);
    } catch { /* not JSON: no query */ }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let v: string | undefined;
    if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field") v = args[++i];
    else if (/^--(?:field|raw-field)=/.test(a)) v = a.slice(a.indexOf("=") + 1);
    else if (/^-[fF][\s\S]/.test(a)) v = a.slice(2);
    if (v?.startsWith("query=")) found.push(v.slice(6));
  }
  return found.length === 1 ? found[0] : undefined;
}

const READ_SUBCOMMANDS = new Set(["issue list", "issue view", "pr list", "pr view", "repo view", "label list"]);

/**
 * Pure. Is this `gh` call a read, so that doing it again is harmless? Anything unclear is not a read.
 * A GraphQL document with a mutation or subscription anywhere in it (also next to a query) is not a read.
 */
export function ghReadOnly(args: readonly string[], input?: string): boolean {
  if (args[0] === "api") {
    if (args.includes("graphql")) {
      const q = graphqlQuery(args, input);
      return q !== undefined && /^\s*(?:query\b|\{)/.test(q) && !/\b(?:mutation|subscription)\b/.test(q);
    }
    const method = apiMethod(args);
    if (method !== undefined) return method === "GET";
    return !args.some((a) => BODY_FLAG.test(a));
  }
  return READ_SUBCOMMANDS.has(`${args[0]} ${args[1]}`);
}

/** The waits before each retry (so also how many): `FACTORY_GH_RETRY_MS` ("1000,3000"); never more than 2 retries. */
export function ghRetryDelays(): number[] {
  const raw = process.env.FACTORY_GH_RETRY_MS ?? "1000,3000";
  return raw.split(",").map((s) => (s.trim() === "" ? NaN : Number(s))).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 2);
}

/** Is this a temporary error of a call that was not killed by its own time limit? */
export function retryableGhError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { killed?: boolean; stderr?: unknown; message?: unknown };
  if (err.killed === true) return false;
  const message = typeof err.message === "string" ? err.message.split("\n").slice(1).join("\n") : "";
  return isTemporaryGitHubError(`${typeof err.stderr === "string" ? err.stderr : ""} ${message}`);
}
