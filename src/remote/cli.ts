import type { UserIo } from "../auth/cli.js";
import { RULES } from "../server/permissions.js";
import { ALL } from "./areas/index.js";
import { ApiError, call, type Fetch } from "./client.js";
import { auto, cols, table } from "./render.js";
import { clearSession, DEFAULT_SERVER, loadSession, saveSession, serverUrl, sessionFile, type CliSession } from "./session.js";
import { dataOf, helpOf, parseCmd, usageOf, type Cmd } from "./spec.js";

export interface RemoteDeps {
  io: UserIo;
  fetcher?: Fetch;
  sessionPath?: string;
  /** The command tables; default: all areas. */
  cmds?: Cmd[];
}

export const REMOTE_USAGE = `Commands that talk to a running Foundry (sign in first):
  scf login [--server ${DEFAULT_SERVER}] [--email you@example.com]
  scf logout | scf whoami
  scf <area>                      List the commands of an area
  scf <area> <action> … [--json]  Do it; --json prints the server's answer as it is
  scf api routes [word]           Every call the server knows, with who may make it
  scf api <METHOD> <path> [--data '{…}' | --data @file.json]
                                  Make any call directly, e.g. scf api GET runs`;

/** Words that are also commands working on files. For these, only a known action is taken here; everything else is left to the file command. */
export const LOCAL_WORDS = ["run", "resume", "approve", "reject", "eval", "clean", "flows", "blocks", "skills", "validate", "new", "ui", "serve", "user", "credential", "monitor", "evidence", "service", "watch", "analyst", "governor", "flaky", "limits", "blockage", "digest"];

const areasOf = (cmds: Cmd[]) => [...new Set(cmds.map((c) => c.area))].sort();

export function areaHelp(cmds: Cmd[], area: string): string {
  const mine = cmds.filter((c) => c.area === area);
  const width = Math.max(...mine.map((c) => usageOf(c).length));
  return [`scf ${area} — commands:`, ...mine.map((c) => `  ${usageOf(c).padEnd(width)}  ${helpOf(c)}`), "", "Every command takes --json, --server <address> and --data '{…}' or --data @file.json (extra fields for the call).", "Add --help to a command to see its options."].join("\n");
}

function flagsOf(argv: string[]): { rest: string[]; server?: string; email?: string; json: boolean; data?: string } {
  const rest: string[] = [];
  const out: { server?: string; email?: string; json: boolean; data?: string } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--server" || a === "--email" || a === "--data") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2) as "server" | "email" | "data"] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { rest, ...out };
}

/** The session to use: the stored one, unless --server names another server (then none: sign in there first). */
function sessionFor(server: string | undefined, path: string): { server: string; session?: CliSession } {
  const stored = loadSession(path);
  const want = server ? serverUrl(server) : (stored?.server ?? DEFAULT_SERVER);
  return { server: want, ...(stored && stored.server === want ? { session: stored } : {}) };
}

async function login(argv: string[], d: RemoteDeps, path: string): Promise<number> {
  const f = flagsOf(argv);
  if (f.rest.length) throw new Error("usage: scf login [--server <address>] [--email <address>]");
  const server = serverUrl(f.server ?? loadSession(path)?.server ?? DEFAULT_SERVER);
  const email = (f.email ?? (await d.io.ask("E-mail: "))).trim();
  // typed without echo; a script may pipe it in. It is sent to the server and never kept.
  const password = d.io.isTTY ? await d.io.askHidden("Password: ") : await d.io.readStdinLine();
  if (!email || !password) throw new Error("an e-mail address and a password are needed");
  const r = await call(server, undefined, { method: "POST", path: "session", body: { email, password } }, d.fetcher);
  const cookie = r.setCookie.map((c) => /^([^=;\s]+)=([^;]+)/.exec(c)).find((m) => m && m[2]);
  if (!cookie) throw new Error("the server did not start a session");
  saveSession({ server, cookie: cookie[1]!, token: cookie[2]!, email }, path);
  d.io.out(`signed in to ${server} as ${email}`);
  return 0;
}

async function api(argv: string[], d: RemoteDeps, path: string): Promise<number> {
  const f = flagsOf(argv);
  const [first, second, ...more] = f.rest;
  if (first === "routes" && !more.length) {
    const word = second?.toLowerCase();
    const rows = RULES.filter((r) => !word || `${r.method} ${r.path} ${r.note}`.toLowerCase().includes(word)).map((r) => ({ method: r.method, path: r.path, who: r.user === "no" ? "admin" : r.user === "own" ? "admin, user (own)" : "admin, user", what: r.note }));
    d.io.out(f.json ? JSON.stringify(rows, null, 2) : table(rows, [...cols("method", "path", "who"), { key: "what", max: 90 }], "no call matches"));
    return 0;
  }
  const method = first?.toUpperCase();
  if (!method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !second || more.length) throw new Error(REMOTE_USAGE);
  const [p, q] = second.replace(/^\/?(api\/)?/, "").split("?");
  const s = sessionFor(f.server, path);
  const body = f.data !== undefined ? dataOf(f.data) : method === "GET" || method === "DELETE" ? undefined : {};
  const r = await call(s.server, s.session, { method, path: p!, ...(q ? { query: Object.fromEntries(new URLSearchParams(q)) } : {}), ...(body !== undefined ? { body } : {}) }, d.fetcher);
  d.io.out(JSON.stringify(r.data ?? null, null, 2));
  return 0;
}

/**
 * The commands that talk to a running Foundry through its API. Returns the exit code, or undefined when
 * the words are not one of these commands (the caller then tries the commands that work on files).
 */
export async function remoteCommand(argv: string[], d: RemoteDeps): Promise<number | undefined> {
  const cmds = d.cmds ?? ALL;
  const path = d.sessionPath ?? sessionFile();
  const [word, action, ...rest] = argv;
  if (!word) return undefined;
  try {
    if (word === "login") return await login(argv.slice(1), d, path);
    if (word === "api") return await api(argv.slice(1), d, path);
    if (word === "logout" && argv.length === 1) {
      const s = loadSession(path);
      if (s) await call(s.server, s, { method: "DELETE", path: "session" }, d.fetcher).catch(() => undefined);
      clearSession(path);
      d.io.out(s ? `signed out of ${s.server}` : "not signed in");
      return 0;
    }
    if (word === "whoami" && argv.length === 1) {
      const s = loadSession(path);
      const me = s ? ((await call(s.server, s, { method: "GET", path: "session" }, d.fetcher)).data as { user?: { email?: string; role?: string } | null }) : undefined;
      d.io.out(me?.user ? `${me.user.email} (${me.user.role}) at ${s!.server}` : `not signed in${s ? ` (the session at ${s.server} has ended)` : ""}: scf login`);
      return me?.user ? 0 : 1;
    }
    if (!areasOf(cmds).includes(word)) return undefined;
    const cmd = cmds.find((c) => c.area === word && c.action === action);
    if (!cmd) {
      // an area of its own lists its commands; a word the file commands also use is left to them
      if (!LOCAL_WORDS.includes(word) && (action === undefined || action === "--help" || action === "help")) return d.io.out(areaHelp(cmds, word)), 0;
      return undefined;
    }
    const p = parseCmd(cmd, rest);
    if (p.help) {
      const flags = Object.entries(cmd.flags ?? {}).map(([n, f]) => [`--${n}${f.type === "string" ? " …" : ""}`, f.help] as const);
      const width = Math.max(0, ...flags.map(([n]) => n.length));
      return d.io.out([usageOf(cmd), `  ${helpOf(cmd)}`, ...flags.map(([n, h]) => `  ${n.padEnd(width)}  ${h}`)].join("\n")), 0;
    }
    if (cmd.confirm && !p.yes) {
      if (!d.io.isTTY) throw new Error(`${cmd.confirm} Add --yes to do it without a question.`);
      if ((await d.io.ask(`${cmd.confirm} Type yes to go on: `)).trim().toLowerCase() !== "yes") return d.io.out("nothing was changed"), 1;
    }
    if (cmd.prompts?.length) {
      const body = { ...((p.call.body as Record<string, unknown> | undefined) ?? {}) };
      for (const q of cmd.prompts) {
        // a value given through --data wins: a script may pass it in a file
        if (body[q.field] !== undefined) continue;
        const ask = () => (d.io.isTTY ? (q.hidden ? d.io.askHidden(`${q.label}: `) : d.io.ask(`${q.label}: `)) : d.io.readStdinLine());
        const v = await ask();
        if (!v) throw new Error(`${q.label.toLowerCase()} is needed`);
        if (q.twice && d.io.isTTY && (await d.io.askHidden(`${q.label} again: `)) !== v) throw new Error("the two entries differ; nothing was changed");
        body[q.field] = v;
      }
      p.call.body = body;
    }
    const s = sessionFor(p.server, path);
    const r = await call(s.server, s.session, p.call, d.fetcher);
    d.io.out(p.json ? JSON.stringify(r.data ?? null, null, 2) : (cmd.show ?? auto)(r.data, p.args));
    return 0;
  } catch (e) {
    if (e instanceof ApiError) {
      d.io.out(`error: ${e.message}`);
      return e.status === 401 || e.status === 403 ? 4 : 1;
    }
    throw e;
  }
}
