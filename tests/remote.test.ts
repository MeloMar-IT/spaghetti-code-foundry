import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL, API_ONLY } from "../src/remote/areas/index.js";
import { RULES } from "../src/server/permissions.js";
import { LOCAL_WORDS } from "../src/remote/cli.js";
import { areaHelp } from "../src/remote/cli.js";
import { apiUrl } from "../src/remote/client.js";
import { auto, cols, fields, table } from "../src/remote/render.js";
import { serverUrl } from "../src/remote/session.js";
import { dataOf, parseCmd, specProblems, usageOf, type Cmd } from "../src/remote/spec.js";
import { remoteWorld, type RemoteWorld } from "./helpers/remote.js";

describe("the command table", () => {
  const answer: Cmd = { area: "runs", action: "answer", method: "POST", path: "runs/:id/answer", args: ["id", "text"], flags: { "max-cost": { type: "string", as: "number", help: "x" }, tags: { type: "string", as: "list", help: "x" }, note: { type: "string", to: "query", help: "x" }, loud: { type: "boolean", required: false, help: "x" } } };
  const list: Cmd = { area: "runs", action: "list", method: "GET", path: "runs", args: ["q"], optional: ["q"], flags: { status: { type: "string", help: "x" }, owner: { type: "string", required: true, help: "x" } } };

  it("turns arguments and flags into the call: path parts, body fields, query", () => {
    const p = parseCmd(answer, ["r 1", "go on", "--max-cost", "2.5", "--tags", "a, b", "--note", "n", "--loud", "--data", '{"extra":true}']);
    expect(p.call).toEqual({ method: "POST", path: "runs/r 1/answer", query: { note: "n" }, body: { text: "go on", maxCost: 2.5, tags: ["a", "b"], loud: true, extra: true } });
    expect(parseCmd(list, ["bug", "--owner", "ann", "--json"])).toMatchObject({ json: true, call: { method: "GET", path: "runs", query: { q: "bug", owner: "ann" } } });
    expect(parseCmd(list, ["--owner", "ann"]).call).toEqual({ method: "GET", path: "runs", query: { owner: "ann" } });
    expect(apiUrl("http://x", "runs/r 1/answer", { note: "a b", none: undefined })).toBe("http://x/api/runs/r%201/answer?note=a+b");
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
    expect(r.out).toMatch(/^error: /);
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
    expect([unknown.code, unknown.out.startsWith("error: ")]).toEqual([1, true]);
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
    expect([r.code, r.out.startsWith("error: ")]).toEqual([4, true]);
    const out = await w.scf(["watchers", "list", "--server", w.base], { as: "nobody" });
    expect(out.out).toMatch(/sign in first: scf login$/);
    expect((await w.scf(["logout"], { as: ann })).out).toBe(`signed out of ${w.base}`);
    expect((await w.scf(["whoami"], { as: ann })).code).toBe(1);
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
