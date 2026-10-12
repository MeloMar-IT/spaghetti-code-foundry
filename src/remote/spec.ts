import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RULES, type Rule } from "../server/permissions.js";
import type { Call } from "./client.js";

export interface Flag {
  type: "string" | "boolean";
  /** Where the value goes: a query parameter or a field of the JSON body. Default: body for calls that change something, query for GET. */
  to?: "query" | "body";
  /** The parameter or field name when it differs from the flag name (flags use dashes: --max-cost → maxCost). */
  key?: string;
  /** Turn the text into the value the API wants. */
  as?: "number" | "json" | "list";
  required?: boolean;
  /** For a boolean flag: what is sent when it is given, instead of true (some routes want "1"). */
  value?: unknown;
  help: string;
}

/** One command: `scf <area> <action> <args…> [flags]` is one call to the API. */
export interface Cmd {
  area: string;
  action: string;
  method: Rule["method"];
  /** The API path as in the permission table, e.g. "runs/:id/answer". */
  path: string;
  /** Names of the positional arguments. Each ":name" of the path must be one; the others go to the body (or the query for GET) under their name. */
  args?: string[];
  /** Positional arguments that are not sent: only `show` uses them, e.g. to pick one thing out of a list the route returns. */
  local?: string[];
  /** The call replaces a whole document, so it is refused without --data: an empty body would wipe it. */
  needsData?: boolean;
  /** Positional arguments that may be left out (the last ones). */
  optional?: string[];
  flags?: Record<string, Flag>;
  /** Fields always sent, e.g. { decision: "approve" }. */
  fixed?: Record<string, unknown>;
  /** One line for the help; default: the note of the route in the permission table. */
  help?: string;
  /** How to print the answer; default: `auto` from render.ts. */
  show?: (data: unknown, args: Record<string, string>) => string;
  /**
   * Body fields that are asked for instead of typed as a flag, so that a secret is never in the shell
   * history or the process list. Hidden ones are typed without echo; without a terminal each is one line of stdin.
   * `twice`: asked a second time and compared (a new password).
   */
  prompts?: { field: string; label: string; hidden?: boolean; twice?: boolean }[];
  /** The call changes or removes something a person may not get back: asks "yes" unless --yes is given. */
  confirm?: string;
}

export const ruleOf = (c: Pick<Cmd, "method" | "path">): Rule | undefined => RULES.find((r) => r.method === c.method && r.path === c.path);
export const helpOf = (c: Cmd): string => c.help ?? ruleOf(c)?.note ?? "";
const params = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);

/** Mistakes in a command table that a test should catch: unknown routes, path parts without an argument, doubles. */
export function specProblems(cmds: Cmd[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of cmds) {
    const name = `${c.area} ${c.action}`;
    if (seen.has(name)) out.push(`${name}: defined twice`);
    seen.add(name);
    if (!ruleOf(c)) out.push(`${name}: ${c.method} ${c.path} is not in the permission table`);
    for (const p of params(c.path)) if (!(c.args ?? []).includes(p)) out.push(`${name}: ":${p}" of the path is not an argument`);
    for (const o of c.optional ?? []) if (!(c.args ?? []).includes(o) || params(c.path).includes(o)) out.push(`${name}: "${o}" cannot be optional`);
    if (!/^[a-z][a-z-]*$/.test(c.area) || !/^[a-z][a-z-]*$/.test(c.action)) out.push(`${name}: names are lower case with dashes`);
  }
  return out;
}

export const usageOf = (c: Cmd): string =>
  `scf ${c.area} ${c.action}${(c.args ?? []).map((a) => ((c.optional ?? []).includes(a) ? ` [${a}]` : ` <${a}>`)).join("")}${Object.entries(c.flags ?? {}).map(([n, f]) => (f.required ? ` --${n}${f.type === "string" ? " …" : ""}` : "")).join("")}`;

/** Options every command takes. */
export const COMMON = { json: { type: "boolean" }, server: { type: "string" }, data: { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean" }, as: { type: "string" } } as const;

const camel = (s: string) => s.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

function convert(name: string, f: Flag, v: string | boolean): unknown {
  if (typeof v === "boolean" || !f.as) return v;
  if (f.as === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  }
  if (f.as === "list") return v.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`--${name} must be JSON`);
  }
}

/** `--data '{"a":1}'` or `--data @file.json`: extra fields of the body, for what the flags do not cover. */
export function dataOf(text: string | undefined, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Record<string, unknown> {
  if (text === undefined) return {};
  let v: unknown;
  try {
    v = JSON.parse(text.startsWith("@") ? read(text.slice(1)) : text);
  } catch (e) {
    throw new Error(text.startsWith("@") ? `--data: ${text.slice(1)} cannot be read as JSON (${(e as Error).message})` : "--data must be JSON, or @file with JSON in it");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("--data must be a JSON object");
  return v as Record<string, unknown>;
}

export interface Parsed { call: Call; args: Record<string, string>; json: boolean; yes: boolean; server?: string; help: boolean }

/** Turn the words after `scf <area> <action>` into the API call. Unknown flags and missing arguments are errors that show the usage. */
export function parseCmd(c: Cmd, argv: string[], read?: (path: string) => string): Parsed {
  const bad = (why: string) => new Error(`${why}\nusage: ${usageOf(c)}`);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { ...Object.fromEntries(Object.entries(c.flags ?? {}).map(([n, f]) => [n, { type: f.type }])), ...COMMON } });
  } catch (e) {
    throw bad((e as Error).message.split("\n")[0]!);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const base = { json: values.json === true, yes: values.yes === true, help: values.help === true, ...(typeof values.server === "string" ? { server: values.server } : {}) };
  if (base.help) return { ...base, call: { method: c.method, path: c.path }, args: {} };
  const names = c.args ?? [];
  const needed = names.filter((n) => !(c.optional ?? []).includes(n)).length;
  if (parsed.positionals.length < needed) throw bad(`missing <${names[parsed.positionals.length]}>`);
  if (parsed.positionals.length > names.length) throw bad(`unexpected "${parsed.positionals[names.length]}"`);
  const args = Object.fromEntries(parsed.positionals.map((v, i) => [names[i]!, v]));
  const inPath = params(c.path);
  const path = c.path.replace(/:(\w+)/g, (_m, p: string) => args[p]!);
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = { ...c.fixed };
  const dest = (to?: "query" | "body") => to ?? (c.method === "GET" ? "query" : "body");
  for (const [k, v] of Object.entries(args)) if (!inPath.includes(k) && !(c.local ?? []).includes(k)) dest() === "query" ? (query[k] = v) : (body[k] = v);
  for (const [name, f] of Object.entries(c.flags ?? {})) {
    const v = values[name];
    if (v === undefined) {
      if (f.required) throw bad(`--${name} is needed`);
      continue;
    }
    const key = f.key ?? camel(name);
    const sent = v === true && f.value !== undefined ? f.value : v;
    if (dest(f.to) === "query") query[key] = String(sent);
    else body[key] = sent === v ? convert(name, f, v) : sent;
  }
  const data = typeof values.data === "string" ? values.data : undefined;
  if (c.needsData && data === undefined) throw bad("--data is needed: this call replaces everything with what you send");
  const extra = dataOf(data, read);
  // a secret typed on the command line stays in the shell history and shows in the process list
  const typed = data !== undefined && !data.startsWith("@") ? (c.prompts ?? []).find((q) => q.field in extra) : undefined;
  if (typed) throw bad(`"${typed.field}" is a secret: leave it out to be asked for it, or give it in a file with --data @file`);
  Object.assign(body, extra);
  // an admin who is viewing as a user (scf admin view-as) reads with that user's rules
  if (typeof values.as === "string") {
    if (c.method !== "GET") throw bad("--as works only with commands that read");
    query.as = values.as;
  }
  const sendsBody = c.method !== "GET" && c.method !== "DELETE" ? true : Object.keys(body).length > 0 && c.method !== "GET";
  return { ...base, args, call: { method: c.method, path, ...(Object.keys(query).length ? { query } : {}), ...(sendsBody ? { body } : {}) } };
}
