import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PEOPLE } from "../src/remote/areas/people.js";
import { parseCmd, specProblems } from "../src/remote/spec.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { remoteWorld, type Ran, type RemoteWorld } from "./helpers/remote.js";
import { TEST_PASSWORD } from "./helpers/session.js";

type Account = { id: string; name: string; email: string; role: string; status: string; hasPassword: boolean };
const cmd = (area: string, action: string) => PEOPLE.find((c) => c.area === area && c.action === action)!;

describe("accounts and administration", () => {
  let w: RemoteWorld;
  let kc: FakeKeychain;
  // the table is passed in, so the test does not depend on the list of all areas
  const scf = (words: string[], o: { as?: string; answers?: string[]; tty?: boolean } = {}): Promise<Ran> => w.scf(words, { ...o, cmds: PEOPLE });
  const accounts = async () => (await scf(["users", "list", "--json"])).json<Account[]>();
  const idOf = async (email: string) => (await accounts()).find((u) => u.email === email)!.id;

  beforeAll(async () => {
    kc = fakeKeychain();
    w = await remoteWorld();
  });
  afterAll(() => {
    w.close();
    kc.remove();
  });

  it("is a table of calls the server knows, and no secret can be a flag or an argument", () => {
    expect(specProblems(PEOPLE)).toEqual([]);
    const words = PEOPLE.flatMap((c) => [...(c.args ?? []), ...Object.keys(c.flags ?? {})]);
    expect(words.filter((x) => /password|secret|token|^current$|^key$/i.test(x))).toEqual([]);
    expect(cmd("account", "password").prompts).toEqual([{ field: "current", label: "Current password", hidden: true }, { field: "password", label: "New password", hidden: true, twice: true }]);
    expect(cmd("secrets", "add").prompts).toEqual([{ field: "secret", label: "Secret", hidden: true }]);
    // every call that blocks, deletes, resets, transfers or changes a role asks first
    const asks = PEOPLE.filter((c) => c.confirm).map((c) => `${c.area} ${c.action}`).sort();
    expect(asks).toEqual(["admin repo-ready", "admin repo-settings", "admin repo-transfer", "admin watcher-remove", "secrets remove", "users add", "users block", "users remove", "users reset", "users role", "users set-app-repos"]);
  });

  it("adds an account and hands its set-password token over once", async () => {
    const r = await scf(["users", "add", "Ann", "ann@example.com"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^id: +[0-9a-f-]{36}$/m);
    expect(r.out).toMatch(/^role: +user$/m);
    expect(r.out).toMatch(/^set-password token \(shown once\): \S{20,}$/m);
    // a new admin is asked about; a new user is not
    await expect(scf(["users", "add", "Bob", "bob@example.com", "--role", "admin"])).rejects.toThrow("This makes an admin: the account can read and change everything. Add --yes to do it without a question.");
    const bob = (await scf(["users", "add", "Bob", "bob@example.com", "--role", "admin", "--json", "--yes"])).json<{ user: Account; token: string }>();
    expect([bob.user.role, bob.user.hasPassword, typeof bob.token]).toEqual(["admin", false, "string"]);
    const twice = await scf(["users", "add", "Ann", "ann@example.com"]);
    expect([twice.code, twice.err]).toEqual([1, "error: an account with that e-mail exists already"]);
  });

  it("lists the accounts and changes a name or an e-mail", async () => {
    const out = (await scf(["users", "list"])).out.split("\n");
    expect(out[0]).toMatch(/^ID +NAME +EMAIL +ROLE +STATUS +PASSWORD +LAST SIGN-IN +RUNS$/);
    expect(out.find((l) => l.includes("ann@example.com"))).toMatch(/Ann +ann@example\.com +user +active +false/);
    const ann = await idOf("ann@example.com");
    const set = await scf(["users", "set", ann, "--name", "Ann B", "--email", "annb@example.com"]);
    expect(set.out).toMatch(/^name: +Ann B$/m);
    expect(set.out).toMatch(/^email: +annb@example\.com$/m);
    expect((await scf(["users", "set", ann, "--email", "ann@example.com", "--json"])).json<{ user: Account }>().user.email).toBe("ann@example.com");
  });

  it("asks before a role change, a block and a reset, and does them with --yes", async () => {
    const ann = await idOf("ann@example.com");
    await expect(scf(["users", "role", ann, "admin"])).rejects.toThrow("an admin can read and change everything. Add --yes to do it without a question.");
    expect(await scf(["users", "role", ann, "admin"], { tty: true, answers: ["no"] })).toMatchObject({ code: 1, out: "nothing was changed" });
    expect((await accounts()).find((u) => u.id === ann)!.role).toBe("user");
    expect((await scf(["users", "role", ann, "admin", "--yes"])).out).toMatch(/^role: +admin$/m);
    expect((await scf(["users", "role", ann, "user", "--yes"])).out).toMatch(/^role: +user$/m);
    expect((await scf(["users", "role", ann, "boss", "--yes"])).err).toBe("error: the role must be admin or user");

    await expect(scf(["users", "block", ann])).rejects.toThrow("This ends the sessions of the account and cancels its queued jobs.");
    const blocked = await scf(["users", "block", ann, "--yes"]);
    expect(blocked.out).toMatch(/^status: +blocked$/m);
    expect(blocked.out).toMatch(/^cancelled: /m);
    expect(parseCmd(cmd("users", "block"), ["u1", "--stop-work"]).call).toEqual({ method: "POST", path: "users/u1/block", body: { stopWork: true } });
    expect((await scf(["users", "unblock", ann])).out).toMatch(/^status: +active$/m);
    expect((await scf(["users", "unlock", ann])).out).toMatch(/^email: +ann@example\.com$/m);

    // an account without a password gets a new link; one with a password is reset
    const link = await scf(["users", "link", ann]);
    expect(link.out).toMatch(/^set-password token \(shown once\): \S{20,}$/m);
    const cat = await w.signIn("cat@example.com");
    const catId = await idOf(cat);
    expect((await scf(["users", "link", catId])).err).toBe("error: this account has a password already");
    await expect(scf(["users", "reset", catId])).rejects.toThrow("This takes the password of the account away and ends its sessions.");
    const reset = await scf(["users", "reset", catId, "--yes"]);
    expect(reset.out).toMatch(/^hasPassword: +false$/m);
    expect(reset.out).toMatch(/^set-password token \(shown once\): \S{20,}$/m);
    // the reset ended the session of the account
    expect((await scf(["whoami"], { as: cat })).code).toBe(4);
  });

  it("shows and sets the limits; null clears one", async () => {
    const ann = await idOf("ann@example.com");
    expect((await scf(["users", "limits"])).out).toBe("defaults:\n  none\n\nno account has limits of its own");
    const d = await scf(["users", "set-default-limits", "--max-concurrent", "2", "--daily-budget", "12.5"]);
    expect(d.out).toContain("defaults:\n  maxConcurrent:  2\n  dailyBudgetUsd: 12.5");
    const own = await scf(["users", "set-limits", ann, "--max-runs-per-day", "7"]);
    expect(own.out.split("\n").slice(-2).join("\n")).toMatch(new RegExp(`^ACCOUNT +MAXCONCURRENT +MAXRUNSPERDAY +DAILYBUDGETUSD\\n${ann} +7$`));
    expect((await scf(["users", "limits", "--json"])).json()).toEqual({ defaults: { maxConcurrent: 2, dailyBudgetUsd: 12.5 }, users: { [ann]: { maxRunsPerDay: 7 } } });
    await scf(["users", "set-limits", ann, "--max-runs-per-day", "null"]);
    await scf(["users", "set-default-limits", "--max-concurrent", "null", "--daily-budget", "null"]);
    expect((await scf(["users", "limits", "--json"])).json()).toEqual({ defaults: {}, users: {} });
    expect((await scf(["users", "set-limits", ann, "--max-concurrent", "0"])).err).toBe("error: maxConcurrent must be a whole number of 1 or more, or null");
  });

  it("shows and sets the repositories an account may connect through the GitHub App", async () => {
    const ann = await idOf("ann@example.com");
    expect((await scf(["users", "app-repos", ann])).out).toBe("no repositories allowed");
    expect((await scf(["users", "set-app-repos", ann, "--repos", "acme/app, acme-tools/*", "--yes"])).out).toBe("acme/app\nacme-tools/*");
    expect((await scf(["users", "app-repos", ann, "--json"])).json()).toEqual({ repos: ["acme/app", "acme-tools/*"] });
    expect((await scf(["users", "set-app-repos", ann, "--repos", "", "--yes"])).out).toBe("no repositories allowed");
    await expect(scf(["users", "set-app-repos", ann])).rejects.toThrow("--repos is needed");
    await expect(scf(["users", "set-app-repos", ann, "--repos", "acme/app"])).rejects.toThrow("This replaces the whole list of repositories the account may connect through the GitHub App. Add --yes");
  });

  it("refuses a normal user every admin command with exit code 4", async () => {
    const dan = await w.signIn("dan@example.com");
    for (const words of [["users", "list"], ["users", "limits"], ["audit", "list"], ["admin", "repos"], ["admin", "secrets"], ["users", "remove", "x", "--yes"]]) {
      const r = await scf(words, { as: dan });
      expect([words.join(" "), r.code, r.err.startsWith("error: ")]).toEqual([words.join(" "), 4, true]);
    }
  });

  it("changes your own password through hidden questions, never through a flag", async () => {
    const eve = await w.signIn("eve@example.com");
    const next = `${TEST_PASSWORD}-next`;
    await expect(scf(["account", "password", "--password", next], { as: eve })).rejects.toThrow(/password/);
    // a terminal: the current one, then the new one two times
    await expect(scf(["account", "password"], { as: eve, tty: true, answers: [TEST_PASSWORD, next, `${next}-typo`] })).rejects.toThrow("the two entries differ; nothing was changed");
    const wrong = await scf(["account", "password"], { as: eve, answers: [`${TEST_PASSWORD}-wrong`, next] });
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toMatch(/^error: /);
    const ok = await scf(["account", "password"], { as: eve, tty: true, answers: [TEST_PASSWORD, next, next] });
    expect([ok.code, ok.out]).toEqual([0, "the password was changed; the other sessions of the account have ended"]);
    expect(ok.out).not.toContain(next);
    // the session of the command line stays; the new password signs in, the old one does not
    expect((await scf(["whoami"], { as: eve })).code).toBe(0);
    expect((await scf(["login", "--server", w.base, "--email", eve], { as: "eve-old", answers: [TEST_PASSWORD] })).code).toBe(4);
    expect((await scf(["login", "--server", w.base, "--email", eve], { as: "eve-new", answers: [next] })).code).toBe(0);
  });

  it("stores, lists and removes a secret without ever printing its value", async () => {
    const fay = await w.signIn("fay@example.com");
    const value = fakeToken();
    expect((await scf(["secrets", "list"], { as: fay })).out).toBe("no stored secrets");
    const added = await scf(["secrets", "add", "deploy"], { as: fay, answers: [value] });
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/^type: +token$/m);
    expect(added.out).toMatch(/^name: +deploy$/m);
    await expect(scf(["secrets", "add", "empty"], { as: fay })).rejects.toThrow("secret is needed");
    const listed = await scf(["secrets", "list"], { as: fay });
    expect(listed.out.split("\n")[0]).toMatch(/^ID +TYPE +NAME +FINGERPRINT +CREATED +LAST USED$/);
    const id = (await scf(["secrets", "list", "--json"], { as: fay })).json<{ id: string }[]>()[0]!.id;
    // the admin sees whose it is, not what it is
    const all = await scf(["admin", "secrets"]);
    expect(all.out).toMatch(/^OWNER +ID +TYPE +NAME/);
    expect(all.out).toMatch(new RegExp(`^fay +${id} +token +deploy`, "m"));
    const allJson = await scf(["admin", "secrets", "--json"]);
    for (const out of [added.out, listed.out, all.out, allJson.out]) expect(out).not.toContain(value);
    // another account's secret is not there to remove
    expect((await scf(["secrets", "remove", id, "--yes"])).err).toBe("error: no such credential");
    await expect(scf(["secrets", "remove", id], { as: fay })).rejects.toThrow("This removes the stored secret; what uses it stops working.");
    expect((await scf(["secrets", "remove", id, "--yes"], { as: fay })).out).toBe("removed");
    expect((await scf(["secrets", "list"], { as: fay })).out).toBe("no stored secrets");
    // a key has many lines: it comes from a file, and is then not asked for
    expect(parseCmd(cmd("secrets", "add"), ["k", "--type", "ssh-key", "--data", "@k.json"], () => '{"secret":"x"}').call).toEqual({ method: "POST", path: "credentials", body: { type: "ssh-key", name: "k", secret: "x" } });
  });

  it("reads the audit log as a table and as CSV, with filters", async () => {
    const ann = await idOf("ann@example.com");
    const all = await scf(["audit", "list"]);
    expect(all.out.split("\n")[0]).toMatch(/^TIME +ACTOR +ACTION +TARGET +RESULT +DETAIL$/);
    const about = (await scf(["audit", "list", "--user", ann, "--action", "block"])).out.split("\n");
    expect(about).toHaveLength(2);
    expect(about[1]).toMatch(/ admin +block +Ann B +ok$/);
    const json = (await scf(["audit", "list", "--action", "block", "--json"])).json<{ entries: { action: string }[]; more: boolean }>();
    expect([json.entries.map((e) => e.action), json.more]).toEqual([["block"], false]);
    expect((await scf(["audit", "list", "--from", "2999-01-01T00:00:00Z"])).out).toBe("no audit lines");
    expect((await scf(["audit", "list", "--action", "nonsense"])).err).toBe('error: "action" is not an audit action');
    const csv = (await scf(["audit", "export", "--action", "block"])).out.split("\n");
    expect(csv[0]!.replace(/^\uFEFF/, "").trim()).toBe("time,actor,actor_name,action,target,target_name,result,detail");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(",block,");
  });

  it("manages the repositories of all accounts: settings, Definition of Ready, watchers, transfer", async () => {
    const made = (await scf(["api", "POST", "repos", "--data", '{"url":"acme/web"}'])).json<{ id: string }>();
    const id = made.id;
    const rows = (await scf(["admin", "repos"])).out.split("\n");
    expect(rows[0]).toMatch(/^ID +URL +METHOD +OWNER +OWNER STATUS$/);
    expect(rows.find((l) => l.startsWith(id))).toMatch(/acme\/web.* +none +admin@example\.com +active$/);

    await expect(scf(["admin", "repo-settings", id, "--test-command", "npm test"])).rejects.toThrow("a setting you do not name is cleared.");
    const set = await scf(["admin", "repo-settings", id, "--test-command", "npm test", "--docs", "docs, README.md", "--main-branch", "main", "--yes", "--json"]);
    expect(set.json<{ settings: unknown }>().settings).toEqual({ testCommand: "npm test", docs: ["docs", "README.md"], mainBranch: "main" });
    expect((await scf(["admin", "repo-settings", id, "--develop-branch", "develop", "--yes"])).out).toMatch(/^settings: +\{"developBranch":"develop"\}$/m);

    const ready = await scf(["admin", "repo-ready", id, "--items", '[{"text":"Has a test plan"}]', "--yes", "--json"]);
    expect(JSON.stringify(ready.json<{ ready: unknown }>().ready)).toContain("Has a test plan");
    expect((await scf(["admin", "repo-ready", id, "--items", "null", "--yes"])).code).toBe(0);
    await expect(scf(["admin", "repo-ready", id])).rejects.toThrow("--items is needed");

    // watchers; added switched off so that nothing is checked on GitHub
    expect((await scf(["admin", "watchers", id])).out).toBe("no watchers");
    const added = await scf(["admin", "watcher-add", id, "--id", "nightly", "--every", "10m", "--label", "go", "--data", '{"enabled":false}']);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/^id: +nightly$/m);
    expect(added.out).toMatch(/^every: +10m$/m);
    const listed = (await scf(["admin", "watchers", id])).out.split("\n");
    expect(listed[0]).toMatch(/^ID +SOURCE +FLOW +EVERY +ENABLED +STATE$/);
    expect(listed[1]).toMatch(/^nightly +issues +default +10m +false +disabled$/);
    expect((await scf(["admin", "watcher-set", id, "nightly", "--every", "30m", "--max-per-tick", "2", "--json"])).json()).toMatchObject({ id: "nightly", every: "30m", max_per_tick: 2, enabled: false });
    expect((await scf(["admin", "watcher-disable", id, "nightly"])).out).toMatch(/^enabled: +false$/m);
    expect(parseCmd(cmd("admin", "watcher-enable"), ["r1", "w1"]).call).toEqual({ method: "PUT", path: "admin/repos/r1/watchers/w1", body: { enabled: true } });
    await expect(scf(["admin", "watcher-remove", id, "nightly"])).rejects.toThrow("This deletes the watcher; it starts no more runs.");
    expect((await scf(["admin", "watcher-remove", id, "nightly", "--yes"])).out).toBe("removed");
    expect((await scf(["admin", "watcher-remove", id, "nightly", "--yes"])).err).toBe("error: no such watcher");

    await expect(scf(["admin", "repo-transfer", id, "bob@example.com"])).rejects.toThrow("a personal token stored for it is removed.");
    const moved = await scf(["admin", "repo-transfer", id, "bob@example.com", "--yes", "--json"]);
    expect(moved.json<{ account: { email: string } }>().account.email).toBe("bob@example.com");
    expect((await scf(["admin", "repo-transfer", id, "nobody@example.com", "--yes"])).code).toBe(1);
  });

  it("starts and ends a read-only view of a user's display", async () => {
    const ann = await idOf("ann@example.com");
    const view = await scf(["admin", "view-as", ann]);
    expect(view.out).toBe(`viewing as Ann B (${ann}) for 30 minutes; read with: scf api GET '<path>?as=${ann}'`);
    expect((await scf(["api", "GET", `runs?as=${ann}`])).code).toBe(0);
    expect((await scf(["admin", "view-end"])).out).toBe("the view has ended");
    expect((await scf(["api", "GET", `runs?as=${ann}`])).code).toBe(4);
    expect((await scf(["admin", "view-as", await idOf("admin@example.com")])).err).toBe("error: you cannot view your own account");
  });

  it("deletes an account after a question", async () => {
    const ann = await idOf("ann@example.com");
    await expect(scf(["users", "remove", ann])).rejects.toThrow("This deletes the account with its sessions, repositories, refinement sessions and stored secrets.");
    const gone = await scf(["users", "remove", ann, "--yes", "--json"]);
    expect(gone.json()).toMatchObject({ ok: true });
    expect((await accounts()).some((u) => u.id === ann)).toBe(false);
    expect((await scf(["users", "remove", ann, "--yes"])).err).toBe("error: no such account");
  });
});
