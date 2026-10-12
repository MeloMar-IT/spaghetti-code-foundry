import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { terminalIo } from "../src/auth/cli.js";
import { ALL, API_ONLY } from "../src/remote/areas/index.js";
import { RULES } from "../src/server/permissions.js";
import { areaHelp, LOCAL_WORDS, remoteCommand } from "../src/remote/cli.js";
import { ApiError, apiUrl, call, type Fetch } from "../src/remote/client.js";
import { auto, cols, fields, table } from "../src/remote/render.js";
import { saveSession, serverUrl } from "../src/remote/session.js";
import { dataOf, parseCmd, specProblems, usageOf, type Cmd } from "../src/remote/spec.js";
import { remoteWorld, type RemoteWorld } from "./helpers/remote.js";
import { TEST_PASSWORD } from "./helpers/session.js";

describe("the command table", () => {
  const answer: Cmd = { area: "runs", action: "answer", method: "POST", path: "runs/:id/answer", args: ["id", "text"], flags: { "max-cost": { type: "string", as: "number", help: "x" }, tags: { type: "string", as: "list", help: "x" }, note: { type: "string", to: "query", help: "x" }, loud: { type: "boolean", required: false, help: "x" } } };
  const list: Cmd = { area: "runs", action: "list", method: "GET", path: "runs", args: ["q"], optional: ["q"], flags: { status: { type: "string", help: "x" }, owner: { type: "string", required: true, help: "x" } } };

  it("turns arguments and flags into the call: path parts, body fields, query", () => {
    const p = parseCmd(answer, ["r 1", "go on", "--max-cost", "2.5", "--tags", "a, b", "--note", "n", "--loud", "--data", '{"extra":true}']);
    expect(p.call).toEqual({ method: "POST", path: "runs/r%201/answer", query: { note: "n" }, body: { text: "go on", maxCost: 2.5, tags: ["a", "b"], loud: true, extra: true } });
    expect(parseCmd(list, ["bug", "--owner", "ann", "--json"])).toMatchObject({ json: true, call: { method: "GET", path: "runs", query: { q: "bug", owner: "ann" } } });
    expect(parseCmd(list, ["--owner", "ann"]).call).toEqual({ method: "GET", path: "runs", query: { owner: "ann" } });
    // the path is encoded where it is built, once: the address takes it as it is
    expect(apiUrl("http://x", p.call.path, { note: "a b", none: undefined })).toBe("http://x/api/runs/r%201/answer?note=a+b");
  });

  it("refuses missing and unknown words with the usage", () => {
    expect(() => parseCmd(answer, ["r1"])).toThrow("missing <text>\nusage: scf runs answer <id> <text>");
    expect(() => parseCmd(answer, ["r1", "t", "more"])).toThrow('unexpected "more"');
    expect(() => parseCmd(answer, ["r1", "t", "--nope"])).toThrow(/nope/);
    expect(() => parseCmd(answer, ["r1", "t", "--max-cost", "much"])).toThrow("--max-cost must be a number");
    expect(() => parseCmd(list, [])).toThrow("--owner is needed");
    expect(usageOf(list)).toBe("scf runs list [q] --owner …");
    expect(dataOf("@f", () => '{"a":1}')).toEqual({ a: 1 });
    expect(() => dataOf("[1]")).toThrow("--data must be a JSON object");
    expect(() => dataOf("{nope")).toThrow("--data must be JSON");
  });

  it("finds mistakes in a table: unknown routes, path parts without an argument, doubles", () => {
    expect(specProblems([answer, list])).toEqual([]);
    expect(specProblems([{ ...answer, args: ["text"] }, { ...list, path: "nowhere" }, list, { ...list, action: "List" }])).toEqual([
      'runs answer: ":id" of the path is not an argument',
      "runs list: GET nowhere is not in the permission table",
      "runs list: defined twice",
      "runs List: names are lower case with dashes",
    ]);
  });

  it("every command of every area is a call the server knows", () => {
    expect(specProblems(ALL)).toEqual([]);
  });

  it("every call of the server has a command, or a reason why not", () => {
    const covered = new Set(ALL.map((c) => `${c.method} ${c.path}`));
    const missing = RULES.map((r) => `${r.method} ${r.path}`).filter((k) => !covered.has(k) && !(k in API_ONLY));
    // a new API route needs a command in src/remote/areas/, or a line in API_ONLY that says why it has none
    expect(missing).toEqual([]);
    expect(Object.keys(API_ONLY).filter((k) => covered.has(k) || !RULES.some((r) => `${r.method} ${r.path}` === k))).toEqual([]);
  });

  it("leaves the words of the file commands alone", () => {
    // these file commands take sub-commands of their own; an API command with the same name would hide them
    const taken: Record<string, string[]> = { monitor: ["on", "off", "status"], user: ["create", "list", "password", "role", "block", "unblock", "delete"], credential: ["rotate-key", "check"], skills: ["pin", "unpin"], service: ["install", "uninstall", "status"] };
    const clash = ALL.filter((c) => taken[c.area]?.includes(c.action)).map((c) => `${c.area} ${c.action}`);
    expect(clash).toEqual([]);
    for (const helper of ["analyst", "governor", "flaky", "limits", "blockage", "digest", "run", "resume", "approve", "reject", "clean", "serve", "ui"]) expect(ALL.some((c) => c.area === helper)).toBe(false);
    expect(LOCAL_WORDS).toContain("flows");
  });

  it("guards what a flag cannot: whole-document calls, secrets on the command line, and viewing as a user", () => {
    const set: Cmd = { area: "settings", action: "set", method: "PUT", path: "config", needsData: true };
    expect(() => parseCmd(set, [])).toThrow("--data is needed: this call replaces everything with what you send");
    const add: Cmd = { area: "secrets", action: "add", method: "POST", path: "credentials", args: ["name"], prompts: [{ field: "secret", label: "Value", hidden: true }] };
    expect(() => parseCmd(add, ["x", "--data", '{"secret":"abc"}'])).toThrow('"secret" is a secret: leave it out to be asked for it, or give it in a file with --data @file');
    expect(parseCmd(add, ["x", "--data", "@f"], () => '{"secret":"abc"}').call.body).toEqual({ name: "x", secret: "abc" });
    const list: Cmd = { area: "runs", action: "list", method: "GET", path: "runs", args: ["pick"], local: ["pick"], flags: { archived: { type: "boolean", value: "1", help: "x" } } };
    expect(parseCmd(list, ["r1", "--archived", "--as", "u1"])).toMatchObject({ args: { pick: "r1" }, call: { method: "GET", path: "runs", query: { archived: "1", as: "u1" } } });
    expect(() => parseCmd(set, ["--data", "{}", "--as", "u1"])).toThrow("--as works only with commands that read");
  });
});

describe("output", () => {
  it("prints lists as tables and one thing as lines", () => {
    expect(table([{ id: "a", n: { x: 1 } }, { id: "long-id", n: { x: 22 } }], [...cols("id"), { key: "n.x", head: "count" }])).toBe("ID       COUNT\na        1\nlong-id  22");
    expect(table([], cols("id"), "no runs")).toBe("no runs");
    expect(fields({ a: 1, bb: "two\nlines", c: null, d: [1] })).toBe("a:  1\nbb: two lines\nd:  [1]");
    expect(auto({ runs: [{ id: "r1", status: "failed", history: [] }] })).toBe("ID  STATUS\nr1  failed");
    expect(auto(undefined)).toBe("done");
    expect(auto([])).toBe("nothing to show");
  });

  it("accepts only plain server addresses", () => {
    expect(serverUrl("localhost:4777/")).toBe("http://localhost:4777");
    expect(serverUrl("https://scf.example.test")).toBe("https://scf.example.test");
    for (const bad of ["http://u:p@x", "http://x/path", "ftp://x", "http://x?a=1"]) expect(() => serverUrl(bad)).toThrow(/not a server address/);
  });
});

describe("against a running server", () => {
  let w: RemoteWorld;
  beforeAll(async () => {
    w = await remoteWorld();
  });
  afterAll(() => w.close());

  it("signs in, keeps the session closed to others, and says who you are", async () => {
    const file = join(w.tmp, "cli-admin_example_com.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { server: string; cookie: string; token: string; email: string };
    expect([stored.server, stored.email]).toEqual([w.base, "admin@example.com"]);
    expect(stored.cookie).toMatch(/^scf_session_\d+$/);
    expect(JSON.stringify(stored)).not.toContain("test-password");
    expect((await w.scf(["whoami"])).out).toBe(`admin@example.com (admin) at ${w.base}`);
  });

  it("refuses a wrong password and stores nothing", async () => {
    const r = await w.scf(["login", "--server", w.base, "--email", "admin@example.com"], { as: "nobody", answers: ["wrong-password-000"] });
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/^error: /);
    // the answer to the sign-in itself: "sign in first" would say nothing, and it is an error, not output
    expect(r.err).not.toMatch(/sign in first|scf login/);
    expect(r.out).toBe("");
    expect((await w.scf(["whoami"], { as: "nobody" })).out).toBe("not signed in: scf login");
  });

  it("makes read and write calls with the session, as tables or as JSON", async () => {
    expect((await w.scf(["server", "health", "--json"])).json<object>()).toBeTypeOf("object");
    expect((await w.scf(["watchers", "list"])).out).toBe("no watchers");
    const dry = await w.scf(["server", "clean", "--dry-run", "--yes", "--json"]);
    expect(dry.code).toBe(0);
    expect(dry.json<object>()).toBeTypeOf("object");
    expect((await w.scf(["api", "GET", "/api/watchers"])).json()).toEqual((await w.scf(["watchers", "list", "--json"])).json());
    const unknown = await w.scf(["watchers", "tick", "nope"]);
    expect([unknown.code, unknown.err.startsWith("error: ")]).toEqual([1, true]);
  });

  it("asks before a change that cannot be undone, and never guesses without a terminal", async () => {
    await expect(w.scf(["server", "clean"])).rejects.toThrow("Add --yes to do it without a question.");
    expect(await w.scf(["server", "clean"], { tty: true, answers: ["no"] })).toMatchObject({ code: 1, out: "nothing was changed" });
    expect((await w.scf(["server", "clean", "--dry-run"], { tty: true, answers: ["yes"] })).code).toBe(0);
  });

  it("answers a user with the server's own rules, and a signed-out call with a hint", async () => {
    const ann = await w.signIn("ann@example.com");
    const r = await w.scf(["watchers", "list"], { as: ann });
    // a call the account may not make: exit code 4, like a missing sign-in
    expect([r.code, r.err.startsWith("error: ")]).toEqual([4, true]);
    const out = await w.scf(["watchers", "list", "--server", w.base], { as: "nobody" });
    expect(out.err).toMatch(/sign in first: scf login$/);
    expect((await w.scf(["logout"], { as: ann })).out).toBe(`signed out of ${w.base}`);
    // not signed in is exit code 4, as for every other command
    expect((await w.scf(["whoami"], { as: ann })).code).toBe(4);
  });

  it("lists the commands of an area and every call of the server", async () => {
    expect(areaHelp(ALL, "watchers")).toContain("scf watchers tick <id>  run a watcher's check now");
    expect((await w.scf(["watchers"])).out).toContain("scf watchers list");
    const routes = await w.scf(["api", "routes", "watchers/:id"]);
    expect(routes.out.split("\n")).toHaveLength(2);
    expect(routes.out).toContain("POST    watchers/:id/tick  admin");
    expect(await w.scf(["nonsense"])).toMatchObject({ code: undefined });
    expect((await w.scf(["watchers", "nonsense"])).code).toBeUndefined();
  });

  it("asks for a secret instead of taking it as a flag", async () => {
    // any route that takes a body will do: the server refuses the unknown field or ignores it, the call itself is what is checked
    const seen: unknown[] = [];
    const cmds: Cmd[] = [{ area: "demo", action: "secret", method: "POST", path: "clean", prompts: [{ field: "dryRun", label: "Password", hidden: true, twice: true }], show: (d) => (seen.push(d), "ok") }];
    expect((await w.scf(["demo", "secret"], { cmds, tty: true, answers: ["s3cret", "s3cret"] })).out).toBe("ok");
    await expect(w.scf(["demo", "secret"], { cmds, tty: true, answers: ["s3cret", "other"] })).rejects.toThrow("the two entries differ");
    await expect(w.scf(["demo", "secret"], { cmds })).rejects.toThrow("password is needed");
    expect((await w.scf(["demo", "secret"], { cmds, answers: ["from-stdin"] })).code).toBe(0);
    // typed on the command line it is refused; from a file it is taken (see the table tests)
    await expect(w.scf(["demo", "secret", "--data", '{"dryRun":true}'], { cmds })).rejects.toThrow('"dryRun" is a secret');
  });

  it("says so when no server answers", async () => {
    writeFileSync(join(w.tmp, "cli-gone.json"), JSON.stringify({ server: "http://127.0.0.1:1", cookie: "c", token: "t", email: "x" }));
    await expect(w.scf(["watchers", "list"], { as: "gone" })).rejects.toThrow("the Foundry at http://127.0.0.1:1 does not answer");
  });
});

/** A web server that is not a Foundry, on this machine. */
async function other(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; close(): void }> {
  const server = createServer(handler);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => void (server.closeAllConnections(), server.close()) };
}

/** An answer for a fetch that is not real. */
const reply = (status: number, body: unknown, type = "application/json", cookies: string[] = []): Awaited<ReturnType<Fetch>> => ({
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? type : null), getSetCookie: () => cookies },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

describe("what the security review found", () => {
  const FAR = "https://foundry.example.test";
  const cmd = (area: string, action: string) => ALL.find((c) => c.area === area && c.action === action)!;
  let w: RemoteWorld;
  /** Run a command signed in at a server that is not there: `answer` is what it would say. Returns what was sent too. */
  const far = async (words: string[], answer: () => Awaited<ReturnType<Fetch>> = () => reply(200, {}), o: { answers?: string[]; tty?: boolean } = {}) => {
    const sent: { url: string; method: string; body?: string }[] = [];
    const fetcher: Fetch = async (url, init) => (sent.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) }), answer());
    writeFileSync(join(w.tmp, "cli-far.json"), JSON.stringify({ server: FAR, cookie: "scf_session_443", token: "fake-session-token", email: "far@example.com" }));
    const r = await w.scf(words, { as: "far", fetcher, ...o });
    return { ...r, sent };
  };
  beforeAll(async () => {
    w = await remoteWorld();
  });
  afterAll(() => w.close());

  it("1: reaches another machine over HTTPS only, so a password never travels in clear text", () => {
    expect(serverUrl("foundry.example.com")).toBe("https://foundry.example.com");
    expect(serverUrl("example.test:8443/")).toBe("https://example.test:8443");
    expect(() => serverUrl("http://foundry.example.com")).toThrow("must be reached over HTTPS");
    expect(() => serverUrl("http://localhost.example.com:4777")).toThrow("must be reached over HTTPS");
    for (const local of ["http://localhost:4777", "http://127.0.0.1:4777", "http://127.8.9.1", "http://[::1]:4777"]) expect(serverUrl(local)).toBe(local);
    expect(serverUrl("127.0.0.1:4777")).toBe("http://127.0.0.1:4777");
    expect(serverUrl("[::1]:4777")).toBe("http://[::1]:4777");
  });

  it("1: signs in to a far server over HTTPS, and not at all over plain http", async () => {
    const urls: string[] = [];
    const fetcher: Fetch = async (url) => (urls.push(url), reply(200, {}, "application/json", ["scf_session_443=fake-session-token; HttpOnly"]));
    await expect(w.scf(["login", "--server", "http://foundry.example.com", "--email", "a@example.com"], { as: "plain", answers: ["fake-password-000"], fetcher })).rejects.toThrow("must be reached over HTTPS");
    expect((await w.scf(["login", "--server", "foundry.example.com", "--email", "a@example.com"], { as: "plain", answers: ["fake-password-000"], fetcher })).code).toBe(0);
    expect(urls).toEqual(["https://foundry.example.com/api/session"]);
    // a session file is no way around it
    writeFileSync(join(w.tmp, "cli-old.json"), JSON.stringify({ server: "http://foundry.example.com", cookie: "scf_session_80", token: "fake-session-token", email: "a@example.com" }));
    await expect(w.scf(["runs", "list"], { as: "old", fetcher })).rejects.toThrow("must be reached over HTTPS");
    expect(urls).toHaveLength(1);
  });

  it("2: scf api sends no body by itself and asks before DELETE, PUT and PATCH", async () => {
    await expect(far(["api", "PUT", "config"])).rejects.toThrow("Add --yes to do it without a question.");
    await expect(far(["api", "DELETE", "users/u1"])).rejects.toThrow("This sends DELETE users/u1 as it is");
    const no = await far(["api", "PATCH", "config"], undefined, { tty: true, answers: ["no"] });
    expect([no.code, no.out, no.sent]).toEqual([1, "nothing was changed", []]);
    expect((await far(["api", "DELETE", "users/u1"], undefined, { tty: true, answers: ["yes"] })).sent).toEqual([{ url: `${FAR}/api/users/u1`, method: "DELETE" }]);
    expect((await far(["api", "PUT", "config", "--yes"])).sent).toEqual([{ url: `${FAR}/api/config`, method: "PUT" }]);
    expect((await far(["api", "PUT", "config", "--yes", "--data", '{"a":1}'])).sent[0]!.body).toBe('{"a":1}');
    // a call that adds is not asked about, and has no body either unless one is given
    expect((await far(["api", "POST", "monitor/off"])).sent).toEqual([{ url: `${FAR}/api/monitor/off`, method: "POST" }]);
    await expect(far(["api", "GET", "runs", "--data", "{}"])).rejects.toThrow("--data does not work with a call that reads");
  });

  it("3: --data adds fields; it never replaces what the command sends or what a guarded command decides", () => {
    const refused: [string, string, string[], string][] = [
      ["users", "set", ["u1", "--data", '{"role":"admin"}'], '--data cannot set "role" for this command'],
      ["users", "add", ["Ann", "ann@example.com", "--data", '{"role":"admin"}'], '--data cannot set "role": use --role'],
      ["repos", "add", ["https://example.com/a/b", "--data", '{"method":"github-token"}'], '--data cannot set "method" for this command'],
      ["repos", "add", ["https://example.com/a/b", "--data", "@f"], '--data cannot set "token" for this command'],
      ["repos", "add-key", ["https://example.com/a/b", "--data", '{"method":"none"}'], '--data cannot set "method" for this command'],
      ["repos", "set-url", ["r1", "https://example.com/a/b", "--data", '{"newKey":true}'], '--data cannot set "newKey" for this command'],
      ["repos", "set-url", ["r1", "https://example.com/a/b", "--data", '{"method":"none"}'], '--data cannot set "method" for this command'],
      ["repos", "use-key", ["r1", "--data", '{"newKey":true}'], '--data cannot set "newKey" for this command'],
      ["monitor", "mute", ["f1", "--reason", "r", "--hours", "2", "--data", '{"hours":null}'], '--data cannot set "hours": use --hours'],
      ["monitor", "mute-for-good", ["f1", "--reason", "r", "--data", '{"hours":1}'], '--data cannot set "hours" for this command'],
      ["turn", "approve", ["k", "--stamp", "s", "--digest", "d", "--data", '{"action":"reject"}'], '--data cannot set "action" for this command'],
      ["turn", "approve", ["k", "--stamp", "s", "--digest", "d", "--data", '{"key":"other"}'], '--data cannot set "key": it is the argument <key>'],
      ["server", "clean", ["--dry-run", "--data", '{"dryRun":false}'], '--data cannot set "dryRun": use --dry-run'],
      ["runs", "answer", ["r1", "ok", "--data", '{"text":"other"}'], '--data cannot set "text": it is the argument <text>'],
    ];
    for (const [area, action, words, why] of refused) expect(() => parseCmd(cmd(area, action), words, () => '{"token":"fake-token"}'), `${area} ${action}`).toThrow(why);
    expect(cmd("users", "set").locked).toEqual(["role"]);
    expect(cmd("repos", "add").locked).toEqual(["method", "token", "username", "newKey"]);
    expect(cmd("repos", "add-token").locked).toEqual(["username", "newKey"]);
    expect(cmd("repos", "set-url").locked).toEqual(["method", "token", "username", "newKey"]);
    for (const c of ALL.filter((x) => x.area === "turn" && x.path === "your-turn/act")) expect(c.locked).toEqual(["action", "key"]);
    for (const c of ALL.filter((x) => x.path === "monitor/mutes" && x.method === "POST")) expect(c.locked).toEqual(["hours"]);
    // a name that holds a secret somewhere is never taken inline, whatever the command; a file is the way
    for (const k of ["token", "password", "secret", "current", "key", "privateKey"]) {
      expect(() => parseCmd(cmd("runs", "archive"), ["r1", "--data", JSON.stringify({ [k]: "fake-value" })]), k).toThrow(`"${k}" is a secret: give it in a file with --data @file`);
    }
    expect(parseCmd(cmd("runs", "archive"), ["r1", "--data", "@f"], () => '{"token":"fake-token"}').call.body).toEqual({ token: "fake-token" });
    // what is still its use: fields no option covers
    expect(parseCmd(cmd("users", "set"), ["u1", "--name", "Ann", "--data", '{"note":"x"}']).call.body).toEqual({ name: "Ann", note: "x" });
  });

  it("4: an argument is one part of the path: it cannot reach another route, and it is encoded once", async () => {
    for (const bad of ["../users/u1", "..", ".", "", "a/b", "a\\b"]) expect(() => parseCmd(cmd("repos", "remove"), [bad, "--yes"]), bad).toThrow('<id> cannot be empty, "." or ".."');
    expect(() => parseCmd(cmd("repos", "remove-github"), ["acme", "../x", "--yes"])).toThrow("<name> cannot be empty");
    const p = parseCmd(cmd("repos", "remove"), ["a b%2Fc?d#e", "--yes"]);
    expect(p.call.path).toBe("repos/a%20b%252Fc%3Fd%23e");
    expect(apiUrl(FAR, p.call.path)).toBe(`${FAR}/api/repos/a%20b%252Fc%3Fd%23e`);
    expect(() => apiUrl(FAR, "repos/../users/u1")).toThrow("is not a path of the API");
    const sent = (await far(["repos", "remove", "r 1", "--yes"])).sent;
    expect(sent).toEqual([{ url: `${FAR}/api/repos/r%201`, method: "DELETE" }]);
    // scf api takes a whole path, but not one that walks
    for (const bad of ["runs/../users/u1", "/api/../x", "runs/./x", ""]) await expect(far(["api", "GET", bad]), bad).rejects.toThrow(/is not a path of the API|Commands that talk/);
    expect((await far(["api", "GET", "/api/runs/r 1/diff?a=b c"])).sent).toEqual([{ url: `${FAR}/api/runs/r%201/diff?a=b+c`, method: "GET" }]);
  });

  it("5: follows no redirect, so a password and a session never go to another address", async () => {
    const seen: string[] = [];
    const trap = await other((req, res) => (seen.push(req.url ?? ""), res.writeHead(200, { "content-type": "application/json", "set-cookie": "scf_session_1=stolen-fake" }).end("{}")));
    const front = await other((_req, res) => void res.writeHead(307, { location: `${trap.base}/api/session` }).end());
    try {
      const r = await w.scf(["login", "--server", front.base, "--email", "admin@example.com"], { as: "moved", answers: [TEST_PASSWORD] });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${front.base} sends this call on to "${trap.base}/api/session" (a redirect): it was not followed`);
      expect(seen).toEqual([]);
      expect(existsSync(join(w.tmp, "cli-moved.json"))).toBe(false);
    } finally {
      trap.close();
      front.close();
    }
  });

  it("6: takes only an answer of the API for a success, and shows the reason of a plain-text refusal", async () => {
    const page = await far(["secrets", "remove", "c1", "--yes"], () => reply(200, "<html>welcome</html>", "text/html"));
    expect([page.code, page.out]).toEqual([1, ""]);
    expect(page.err).toBe(`error: this does not look like a Foundry server: ${FAR} did not answer with JSON; check the address (--server)`);
    expect((await far(["secrets", "remove", "c1", "--yes"], () => reply(200, "ok", "text/plain"))).code).toBe(1);
    expect((await far(["secrets", "remove", "c1", "--yes"], () => reply(200, "not json", "application/json"))).code).toBe(1);
    expect((await far(["secrets", "remove", "c1", "--yes"], () => reply(200, {}))).out).toBe("removed");
    // CSV is what the audit export answers, and nothing else does
    expect((await far(["audit", "export"], () => reply(200, "time,actor\n", "text/csv; charset=utf-8"))).out).toBe("time,actor");
    expect((await far(["audit", "list"], () => reply(200, "time,actor\n", "text/csv"))).code).toBe(1);
    const refused = await far(["runs", "list"], () => reply(403, `forbidden host\nmore ${"x".repeat(300)}`, "text/plain"));
    expect([refused.code, refused.err]).toEqual([4, "error: the server answered 403: forbidden host"]);
    const long = await far(["runs", "list"], () => reply(400, "y".repeat(300), ""));
    expect(long.err).toBe(`error: the server answered 400: ${"y".repeat(199)}…`);
    expect((await far(["runs", "list"], () => reply(502, "<html><body>Bad Gateway</body></html>", "text/html"))).err).toBe("error: the server answered 502");
    // the real server's own refusal of a host it does not know
    const elsewhere: Fetch = (url, init) =>
      new Promise((ok, fail) => {
        const req = request(url, { method: init.method, headers: { ...init.headers, host: "other.example.com" } }, (res) => {
          let text = "";
          res.setEncoding("utf8").on("data", (c: string) => (text += c)).on("end", () => ok({ status: res.statusCode ?? 0, headers: { get: (n) => (res.headers[n] as string | undefined) ?? null }, text: async () => text }));
        });
        req.on("error", fail).end();
      });
    const host = await call(w.base, undefined, { method: "GET", path: "info" }, elsewhere).catch((e: ApiError) => e);
    expect(host).toBeInstanceOf(ApiError);
    expect((host as ApiError).message).toMatch(/^the server answered 403: \S/);
  });

  it("7: reads standard input line by line, so two secrets can be piped in", async () => {
    const pipe = (text: string) => {
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
      stdin.end(text);
      return terminalIo(stdin, new PassThrough() as unknown as NodeJS.WriteStream);
    };
    const io = pipe("old\r\nnew\n\nlast");
    expect([await io.readStdinLine(), await io.readStdinLine(), await io.readStdinLine(), await io.readStdinLine(), await io.readStdinLine()]).toEqual(["old", "new", "", "last", undefined]);
    expect(await pipe("").readStdinLine()).toBeUndefined();

    // through the real terminal code: the current and the new password, then a sign-in with the e-mail address and the new one
    const pat = await w.signIn("pat@example.com");
    const next = "piped-password-24680";
    const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const sessionPath = join(w.tmp, "cli-pat_example_com.json");
      expect(await remoteCommand(["account", "password"], { io: pipe(`${TEST_PASSWORD}\n${next}\n`), sessionPath })).toBe(0);
      expect(await remoteCommand(["login", "--server", w.base], { io: pipe(`${pat}\n${next}\n`), sessionPath })).toBe(0);
      expect(printed.mock.calls.map((c) => String(c[0]))).toContain(`signed in to ${w.base} as ${pat}\n`);
    } finally {
      printed.mockRestore();
    }
    // the helper's pipe behaves the same: no question can be asked, one line per read
    expect((await w.scf(["login", "--server", w.base], { as: "pat2", answers: [pat, next] })).code).toBe(0);
    await expect(w.scf(["login", "--server", w.base], { as: "pat2", answers: [pat] })).rejects.toThrow("an e-mail address and a password are needed");
  });

  it("8: an empty value is not the number 0", () => {
    const clean = cmd("server", "clean");
    for (const bad of ["", "  ", "1e3", "0x10", "7 days", "Infinity"]) expect(() => parseCmd(clean, ["--older-than", bad, "--yes"]), bad).toThrow("--older-than must be a number");
    expect(parseCmd(clean, ["--older-than", "30", "--yes"]).call.body).toEqual({ dryRun: false, olderThanDays: 30 });
    expect(parseCmd(clean, ["--older-than", " 2.5 ", "--yes"]).call.body).toMatchObject({ olderThanDays: 2.5 });
  });

  it("9: keeps the Foundry's session cookie only", async () => {
    const login = (cookies: string[]) => w.scf(["login", "--server", FAR, "--email", "a@example.com"], { as: "cookie", answers: ["fake-password-000"], fetcher: async () => reply(200, {}, "application/json", cookies) });
    await expect(login(["tracker=fake-tracker; Path=/"])).rejects.toThrow("the server did not start a session");
    expect(existsSync(join(w.tmp, "cli-cookie.json"))).toBe(false);
    expect((await login(["tracker=fake-tracker; Path=/", "scf_session_443=fake-session-token; HttpOnly; Path=/"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(w.tmp, "cli-cookie.json"), "utf8"))).toMatchObject({ cookie: "scf_session_443", token: "fake-session-token" });
  });

  it("10: writes the session to a new closed file, never through what is at its place", () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-session-"));
    try {
      const session = { server: FAR, cookie: "scf_session_443", token: "fake-session-token", email: "a@example.com" };
      const open = join(dir, "open.json");
      writeFileSync(open, "{}", { mode: 0o644 });
      saveSession(session, open);
      expect(statSync(open).mode & 0o777).toBe(0o600);
      const elsewhere = join(dir, "elsewhere.txt");
      writeFileSync(elsewhere, "untouched");
      const link = join(dir, "link.json");
      symlinkSync(elsewhere, link);
      saveSession(session, link);
      expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(JSON.parse(readFileSync(link, "utf8"))).toEqual(session);
      expect(statSync(link).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("11: prints a refusal on standard error, whole with --json", async () => {
    const body = { error: "the issue changed", changed: { issue: 7, seen: "abc" } };
    const plain = await far(["runs", "list"], () => reply(409, body));
    expect([plain.code, plain.out, plain.err]).toEqual([1, "", "error: the issue changed"]);
    const json = await far(["runs", "list", "--json"], () => reply(409, body));
    expect([json.code, json.out, JSON.parse(json.err)]).toEqual([1, "", body]);
    expect((await w.scf(["whoami"], { as: "nobody-at-all" })).code).toBe(4);
  });

  it("12 and 13: says how to give text that starts with a dash, and refuses --data where it would be dropped", async () => {
    const save = cmd("flows", "save");
    expect(() => parseCmd(save, ["x", "---\nname: x\n", "--scope", "repo"])).toThrow('everything after -- is taken as text');
    expect(parseCmd(save, ["x", "--scope", "repo", "--", "---\nname: x\n"]).call.body).toEqual({ yaml: "---\nname: x\n", scope: "repo" });
    expect((await w.scf(["flows", "save", "--help"])).out).toContain('everything after -- is taken as text');
    expect((await w.scf(["runs", "show", "--help"])).out).not.toContain("taken as text");
    expect(() => parseCmd(cmd("runs", "list"), ["--data", '{"status":"failed"}'])).toThrow("--data does not work with a command that reads: use --status, --flow, --repo, --since, --owner, --archived");
    expect(() => parseCmd(cmd("runs", "show"), ["r1", "--data", "{}"])).toThrow("this command takes no options of its own");
  });

  it("14: a word the file commands share lists its server commands, and a mistyped action stops", async () => {
    const wrong = await w.scf(["flows", "delete", "x"]);
    expect([wrong.code, wrong.out]).toEqual([1, ""]);
    expect(wrong.err).toMatch(/^error: scf flows has no command "delete"\nscf flows — commands:/);
    expect(wrong.err).toContain("scf flows remove <name>");
    const monitor = await w.scf(["monitor", "now"]);
    expect(monitor.code).toBe(1);
    expect(monitor.err).toContain("scf monitor mute <finding>");
    expect(monitor.err).toContain("scf monitor on, scf monitor off, scf monitor status");
    // the file commands keep what is theirs, with a line that says where the others are
    expect(await w.scf(["flows"])).toMatchObject({ code: undefined, out: "", err: "(for the commands of a running Foundry: scf flows --help)" });
    expect(await w.scf(["blocks", "--repo", "."])).toMatchObject({ code: undefined, out: "" });
    for (const own of ["on", "off", "status"]) expect(await w.scf(["monitor", own])).toMatchObject({ code: undefined, out: "", err: "" });
    for (const area of ["flows", "blocks", "monitor"]) expect((await w.scf([area, "--help"])).out).toContain(`scf ${area} — commands:`);
  });

  it("15: gives up after a time, and does not wait for a stream that never ends", async () => {
    const silent = await other(() => undefined);
    const stream = await other((_req, res) => void res.writeHead(200, { "content-type": "text/event-stream" }).write("data: 1\n\n"));
    try {
      await expect(call(silent.base, undefined, { method: "GET", path: "info", timeoutMs: 100 })).rejects.toThrow(`the Foundry at ${silent.base} did not answer within 0 seconds`);
      const e = await call(stream.base, undefined, { method: "GET", path: "runs/r1/events" }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as Error).message).toContain("the command line cannot follow a live stream");
    } finally {
      silent.close();
      stream.close();
    }
    // every call has a limit, the sign-in a shorter one
    const limits: (number | undefined)[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (limits.push(ms), real(ms)));
    try {
      await far(["runs", "list"]);
      await w.scf(["login", "--server", FAR, "--email", "a@example.com"], { as: "timed", answers: ["fake-password-000"], fetcher: async () => reply(200, {}, "application/json", ["scf_session_443=fake-session-token"]) });
    } finally {
      spy.mockRestore();
    }
    expect(limits).toEqual([120_000, 30_000]);
  });

  it("16: a file that is not JSON is not quoted in the error", () => {
    let said = "";
    try {
      dataOf("@token.txt", () => "ghp_fakeTokenFakeTokenFakeToken");
    } catch (e) {
      said = (e as Error).message;
    }
    expect(said).toBe("--data: token.txt cannot be read as JSON");
    expect(() => dataOf("@missing.json")).toThrow("--data: missing.json cannot be read");
  });
});
