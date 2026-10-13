import { cols, fields, pick, table, type Column } from "../render.js";
import type { Cmd, Flag } from "../spec.js";

type Row = Record<string, unknown>;
const rows = (d: unknown, key?: string): Row[] => {
  const v = key ? pick(d, key) : d;
  return Array.isArray(v) ? (v as Row[]) : [];
};
const yesNo = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "");

// ---- repositories ----------------------------------------------------------------------------------

/** The last connection test in one word. */
const connection = (r: Row) => (r.connection ? (pick(r, "connection.ok") ? "ok" : "failed") : "not tested");
const REPO_COLS: Column[] = [...cols("id", "url", "method"), { key: "connection" }];
const repoRow = (r: Row) => ({ ...r, connection: connection(r) });

/** One repository as lines. A public key is shown in full: it has to be copied to the host of the repository. */
function repoLines(d: unknown): string {
  const r = (d ?? {}) as Row;
  const head = fields({ ...r, connection: connection(r), tested: pick(r, "connection.at") }, ["id", "url", "github", "method", "username", "added", "connection", "tested"]);
  const checks = rows(r, "connection.checks").map((c) => `  ${c.check}: ${c.ok ? "ok" : c.skipped ? "skipped" : "failed"} (${c.message})`);
  const key = typeof r.publicKey === "string" ? ["", "Public key (add it as a deploy key with write access):", r.publicKey.trim()] : [];
  return [head, ...checks, ...key].join("\n");
}

const TOKEN = [{ field: "token", label: "Access token", hidden: true }];
const USERNAME: Record<string, Flag> = { username: { type: "string", help: "the user name the token belongs to" } };
const SIGN_IN_LOST = "The sign-in stored for this repository (its token or key) is replaced and cannot be read back.";

/**
 * What decides how a repository is signed in to. One call takes all of them, so --data may set none of them: each
 * command sends its own (and asks before it replaces a sign-in), and a token is asked for.
 */
const SIGN_IN_FIELDS = ["method", "token", "username", "newKey"];
const own = (c: Cmd) => [...Object.keys(c.fixed ?? {}), ...(c.prompts ?? []).map((q) => q.field), ...Object.entries(c.flags ?? {}).map(([n, f]) => f.key ?? n)];
const signIn = (c: Cmd): Cmd => ({ ...c, locked: SIGN_IN_FIELDS.filter((k) => !own(c).includes(k)) });

const REPOS: Cmd[] = [
  { area: "repos", action: "list", method: "GET", path: "repos", show: (d) => table(rows(d).map(repoRow), REPO_COLS, "no repositories") },
  // the API has no call for one repository: the list is read and the one with this id is shown
  { area: "repos", action: "show", method: "GET", path: "repos", args: ["id"], local: ["id"], help: "one of your repositories, with its last connection test and its public key",
    show: (d, a) => {
      const r = rows(d).find((x) => x.id === a.id);
      return r ? repoLines(r) : `no repository with the id ${a.id}`;
    } },
  { area: "repos", action: "methods", method: "GET", path: "repos/methods", help: "the sign-in methods you may choose",
    show: (d) => fields({ methods: rows(d, "methods").join(", "), "github app": pick(d, "githubApp.available") ? "set up" : "not set up", "install link": pick(d, "githubApp.installUrl") }) },

  signIn({ area: "repos", action: "add", method: "POST", path: "repos", args: ["url"], help: "add a repository without a sign-in of its own (choose one later with a use-… command)", show: repoLines }),
  signIn({ area: "repos", action: "add-token", method: "POST", path: "repos", args: ["url"], fixed: { method: "github-token" }, prompts: TOKEN, help: "add a GitHub repository with a fine-grained token (asked for, never typed as an argument)", show: repoLines }),
  signIn({ area: "repos", action: "add-https-token", method: "POST", path: "repos", args: ["url"], fixed: { method: "https-token" }, prompts: TOKEN, flags: { username: { ...USERNAME.username!, required: true } }, help: "add an https repository on any host with a user name and a token (the token is asked for)", show: repoLines }),
  signIn({ area: "repos", action: "add-key", method: "POST", path: "repos", args: ["url"], fixed: { method: "ssh-deploy-key" }, help: "add a repository by its SSH address; the Foundry makes a deploy key and shows its public half", show: repoLines }),
  signIn({ area: "repos", action: "add-app", method: "POST", path: "repos", args: ["url"], fixed: { method: "github-app" }, help: "add a GitHub repository that the installed GitHub App signs in to", show: repoLines }),

  signIn({ area: "repos", action: "use-token", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { method: "github-token" }, prompts: TOKEN, confirm: SIGN_IN_LOST, help: "sign in to the repository with a GitHub fine-grained token (asked for); also replaces the token", show: repoLines }),
  signIn({ area: "repos", action: "use-https-token", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { method: "https-token" }, prompts: TOKEN, flags: USERNAME, confirm: SIGN_IN_LOST, help: "sign in with a user name and a token (asked for); --username is needed when the method changes", show: repoLines }),
  signIn({ area: "repos", action: "use-key", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { method: "ssh-deploy-key" }, confirm: SIGN_IN_LOST, help: "sign in with a deploy key the Foundry makes (SSH address only); keeps a key that is there", show: repoLines }),
  signIn({ area: "repos", action: "new-key", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { newKey: true }, confirm: "A new deploy key is made; the old one stops working at once.", help: "make a new deploy key for a repository that uses one", show: repoLines }),
  signIn({ area: "repos", action: "use-app", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { method: "github-app" }, confirm: SIGN_IN_LOST, help: "let the installed GitHub App sign in to the repository", show: repoLines }),
  signIn({ area: "repos", action: "use-server-login", method: "PUT", path: "repos/:id/auth", args: ["id"], fixed: { method: "none" }, confirm: "The token or key stored for this repository is removed; the server's own access is used.", help: "remove the repository's sign-in and use the server's own access (admin only)", show: repoLines }),
  signIn({ area: "repos", action: "set-url", method: "PUT", path: "repos/:id/auth", args: ["id", "url"], help: "change the address to another form of the same repository (https or SSH)", show: repoLines }),

  { area: "repos", action: "test", method: "POST", path: "repos/:id/test", args: ["id"], help: "test the connection of a repository; the result is saved as its connection status",
    show: (d) => [`connection: ${pick(d, "ok") ? "ok" : "failed"}`, table(rows(d, "checks").map((c) => ({ ...c, result: c.ok ? "ok" : c.skipped ? "skipped" : "failed" })), [...cols("check", "result", "code"), { key: "message", max: 120 }])].join("\n") },
  { area: "repos", action: "ready", method: "GET", path: "repos/:id/ready", args: ["id"], help: "the Definition of Ready of a repository",
    show: (d) => [pick(d, "isDefault") ? "the default list" : "this repository's own list", table(rows(d, "items"), [...cols("id"), { key: "text", max: 100 }], "no items")].join("\n") },
  { area: "repos", action: "remove", method: "DELETE", path: "repos/:id", args: ["id"], confirm: "The repository, its stored token or key and its watchers are removed." },
  { area: "repos", action: "remove-github", method: "DELETE", path: "repos/:owner/:name", args: ["owner", "name"], confirm: "The repository, its stored token or key and its watchers are removed.", help: "remove a GitHub repository by owner and name instead of its id" },
];

// ---- settings and providers ------------------------------------------------------------------------

const SETTINGS: Cmd[] = [
  { area: "settings", action: "show", method: "GET", path: "config", help: "the settings as they are in the configuration file", show: (d) => JSON.stringify(d, null, 2) },
  // PUT /api/config takes the whole configuration: a setting left out goes back to its default (the server writes only the difference to the file)
  { area: "settings", action: "set", method: "PUT", path: "config", needsData: true,
    help: "REPLACE all settings with --data '{…}' or --data @file; what you leave out goes back to its default. Start from: scf settings show --json",
    confirm: "The whole configuration is replaced by what you give with --data; every setting you leave out goes back to its default.",
    show: (d) => `saved\n${JSON.stringify(d, null, 2)}` },
];

const PROVIDERS: Cmd[] = [
  { area: "providers", action: "list", method: "GET", path: "providers", help: "the agents on the server and the model providers, with whether each one works",
    show: (d) => [
      table(rows(d, "agents").map((a) => ({ ...a, installed: yesNo(a.installed), "signed in": yesNo(a.loggedIn) })), [...cols("agent", "installed", "signed in", "version"), { key: "detail", max: 80 }], "no agents"),
      "",
      table(rows(d, "providers").map((p) => ({ ...p, works: yesNo(p.ok), agents: rows(p, "agents").join(", "), models: rows(p, "models").length || "" })), [...cols("name", "kind", "works", "agents", "models"), { key: "detail", max: 80 }], "no providers"),
    ].join("\n") },
  { area: "providers", action: "test", method: "POST", path: "providers/test", args: ["spec"], help: "ask a model for one word, e.g. scf providers test claude:sonnet (this can take a minute)", show: (d) => fields(d, ["target", "ok", "seconds", "error", "output"]) },
];

// ---- the monitor -----------------------------------------------------------------------------------
// `scf monitor on|off|status` are file commands: these actions must have other names.

const FINDING_COLS: Column[] = [...cols("id", "state", "severity", "detector", "count", "lastSeen"), { key: "summary", max: 70 }];
const MUTE_COLS: Column[] = [...cols("id", "kind", "detector", "finding", "until"), { key: "reason", max: 60 }];
const monitorState = (d: unknown) => fields(d, ["state", "why", "running", "reportTo", "lastCheck", "perDay", "madeToday"]);
const findings = (d: unknown) => table(rows(d, "findings"), FINDING_COLS, pick(d, "findingsUnreadable") ? "the findings file cannot be read" : "no findings");
const mutes = (d: unknown) => table(rows(d, "mutes").map((m) => ({ ...m, until: m.until ?? "for good" })), MUTE_COLS, "no mutes");
const MUTE_FLAGS: Record<string, Flag> = { reason: { type: "string", required: true, help: "why (1 to 200 characters)" } };
const HOURS: Flag = { type: "string", as: "number", required: true, help: "for how many hours" };
const muted = (d: unknown) => `muted (id ${pick(d, "mute.id")}) ${pick(d, "mute.until") ? `until ${pick(d, "mute.until")}` : "for good"}`;
const FOR_GOOD = "stays silent until someone ends the mute with: scf monitor unmute <id>.";

const MONITOR: Cmd[] = [
  { area: "monitor", action: "show", method: "GET", path: "monitor", help: "whether the monitor makes bug stories, when it last checked and how many stories it made today",
    show: (d) => [monitorState(d), `findings: ${rows(d, "findings").length}`, `mutes:    ${rows(d, "mutes").length}`].join("\n") },
  { area: "monitor", action: "findings", method: "GET", path: "monitor", help: "the findings of the monitor with their states", show: findings },
  { area: "monitor", action: "mutes", method: "GET", path: "monitor", help: "the mutes in force", show: mutes },
  { area: "monitor", action: "detectors", method: "GET", path: "monitor", help: "the detectors of the monitor, their thresholds and when each last found something",
    show: (d) => table(rows(d, "detectors"), [...cols("name", "lastFound", "thresholds")], "no detectors") },
  { area: "monitor", action: "finding", method: "GET", path: "monitor/findings/:id", args: ["id"],
    show: (d) => [
      `finding ${pick(d, "id")}`,
      ...rows(d, "evidence").map((e) => `  ${typeof e === "string" ? e : JSON.stringify(e)}`),
      "",
      table(rows(d, "stories").map((s) => ({ ...s, current: yesNo(s.current) })), cols("issue", "current", "url"), "no bug stories"),
      "",
      table(rows(d, "runs"), cols("id", "status", "startedAt"), "no runs"),
    ].join("\n") },
  { area: "monitor", action: "story", method: "POST", path: "monitor/story", args: ["finding"], help: "make the bug story of one finding now (the off switch, mutes and the two tries still apply)",
    show: (d) => `${pick(d, "story.made") ? "made" : "found"} bug story #${pick(d, "story.issue")} ${pick(d, "story.url") ?? ""}`.trimEnd() },
  { area: "monitor", action: "stop-stories", method: "POST", path: "monitor/off", show: (d) => `${pick(d, "changed") ? "bug stories are switched off" : "bug stories were off already"}\n${monitorState(d)}` },
  { area: "monitor", action: "start-stories", method: "POST", path: "monitor/on", show: (d) => `${pick(d, "changed") ? "bug stories are switched on" : "nothing changed"}\n${monitorState(d)}` },
  { area: "monitor", action: "mute", method: "POST", path: "monitor/mutes", args: ["finding"], flags: { ...MUTE_FLAGS, hours: HOURS }, locked: ["hours"], help: "mute one finding for a number of hours, with a reason", show: muted },
  { area: "monitor", action: "mute-detector", method: "POST", path: "monitor/mutes", args: ["detector"], flags: { ...MUTE_FLAGS, hours: HOURS }, locked: ["hours"], help: "mute a whole detector for a number of hours, with a reason", show: muted },
  { area: "monitor", action: "mute-for-good", method: "POST", path: "monitor/mutes", args: ["finding"], flags: MUTE_FLAGS, locked: ["hours"], confirm: `This finding ${FOR_GOOD}`, help: "mute one finding with no end, with a reason", show: muted },
  { area: "monitor", action: "mute-detector-for-good", method: "POST", path: "monitor/mutes", args: ["detector"], flags: MUTE_FLAGS, locked: ["hours"], confirm: `Every finding of this detector ${FOR_GOOD}`, help: "mute a whole detector with no end, with a reason", show: muted },
  { area: "monitor", action: "unmute", method: "DELETE", path: "monitor/mutes/:id", args: ["id"], show: (d) => `the mute has ended\n${mutes(d)}` },
  { area: "monitor", action: "retry", method: "POST", path: "monitor/retry", args: ["finding"], help: "let the monitor try again for a finding that waits for a person", show: (d) => `the monitor will try again\n${findings(d)}` },
];

// ---- flows and blocks ------------------------------------------------------------------------------
// `scf flows` and `scf blocks` without an action are file commands; with one of these actions they are calls.

const SCOPE: Record<string, Flag> = { scope: { type: "string", required: true, help: '"repo" (this server\'s folder) or "global" (every folder)' } };
const YAML_HINT = 'give the YAML as text after --, e.g. -- "$(cat my.yaml)"';
/** Whether a save replaces a file: the list of the server has one with this name in the scope that is written to. */
const saved = (list: string, key: string, arg: string): NonNullable<Cmd["confirmIf"]> => async (body, args, get) => rows(await get(list)).some((x) => x[key] === args[arg] && x.scope === body.scope);

const FLOWS: Cmd[] = [
  { area: "flows", action: "list", method: "GET", path: "flows", flags: { published: { type: "boolean", value: "1", help: "only the published flows, as a user sees them" } }, help: "the flows of the server (a user sees the published flows only)",
    show: (d) => {
      const list = rows(d);
      // a user gets the published flows in another shape: with a title and a version
      if (list.some((f) => "version" in f)) return table(list, [...cols("name", "version", "title"), { key: "description", max: 70 }], "no flows");
      // the error column only when a flow cannot be read
      return table(list.map((f) => ({ ...f, published: f.published ? "yes" : "no" })), [...cols("name", "scope", "published"), { key: "description", max: 60 }, ...(list.some((f) => f.error) ? [{ key: "error", max: 60 }] : [])], "no flows");
    } },
  { area: "flows", action: "show", method: "GET", path: "flows/:name", args: ["name"], help: "print the YAML of a flow", show: (d) => String(pick(d, "yaml") ?? "").trimEnd() },
  { area: "flows", action: "save", method: "PUT", path: "flows/:name", args: ["name", "yaml"], flags: SCOPE, help: `save a flow (asks before it replaces one); ${YAML_HINT}`,
    confirm: "A flow with this name is saved there already: its file is replaced.", confirmIf: saved("flows", "name", "name"),
    show: (d) => `saved ${pick(d, "name")} (${pick(d, "scope")})${pick(d, "version") !== undefined ? `, published as version ${pick(d, "version")}` : ""}` },
  { area: "flows", action: "remove", method: "DELETE", path: "flows/:name", args: ["name"], confirm: "The file of this flow is deleted.", show: (d) => `deleted ${pick(d, "deleted")}` },
  { area: "flows", action: "check", method: "POST", path: "validate", args: ["yaml"], help: `check a flow without saving it; ${YAML_HINT}`,
    show: (d) => (pick(d, "ok") ? `ok: ${pick(d, "flow.name")}` : [`not valid: ${pick(d, "error")}`, ...rows(d, "issues").map((i) => `  ${i.path}: ${i.message}`)].join("\n")) },
  { area: "flows", action: "generate", method: "POST", path: "generate", args: ["request"], flags: { current: { type: "string", help: "the YAML of a flow to change instead of writing a new one" } }, help: "let AI write a flow from a description and print it (costs money, takes minutes; nothing is saved)",
    show: (d) => [String(pick(d, "yaml") ?? "").trimEnd(), ...(pick(d, "error") ? [`# not valid: ${pick(d, "error")}`] : []), `# cost: $${Number(pick(d, "costUsd") ?? 0).toFixed(2)}`].join("\n") },
  { area: "flows", action: "evals", method: "GET", path: "evals", help: "the latest eval reports", show: (d) => table(rows(d), [...cols("suite", "startedAt", "finishedAt"), { key: "file", max: 100 }], "no eval reports") },
];

const BLOCKS: Cmd[] = [
  { area: "blocks", action: "list", method: "GET", path: "blocks", show: (d) => table(rows(d).map((b) => ({ ...b, name: pick(b, "block.name") })), [...cols("id", "scope", "name"), ...(rows(d).some((b) => b.error) ? [{ key: "error", max: 70 }] : [])], "no blocks") },
  // the API has no call for one block: the list is read and the one with this id is printed
  { area: "blocks", action: "show", method: "GET", path: "blocks", args: ["id"], local: ["id"], help: "print the YAML of a block",
    show: (d, a) => {
      const b = rows(d).find((x) => x.id === a.id);
      return b ? String(b.yaml ?? "").trimEnd() : `no block with the id ${a.id}`;
    } },
  { area: "blocks", action: "save", method: "PUT", path: "blocks/:id", args: ["id", "yaml"], flags: SCOPE, help: `save a block (asks before it replaces one); ${YAML_HINT}`,
    confirm: "A block with this id is saved there already: its file is replaced.", confirmIf: saved("blocks", "id", "id"), show: (d) => `saved ${pick(d, "id")} (${pick(d, "scope")})` },
  { area: "blocks", action: "remove", method: "DELETE", path: "blocks/:id", args: ["id"], confirm: "The file of this block is deleted.", show: (d) => `deleted ${pick(d, "deleted")}` },
];

/** Setting the Foundry up: repositories, settings, model providers, the monitor, flows and blocks. */
export const SETUP: Cmd[] = [...REPOS, ...SETTINGS, ...PROVIDERS, ...MONITOR, ...FLOWS, ...BLOCKS];
