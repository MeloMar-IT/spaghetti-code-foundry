import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveFindings, type Finding } from "../src/monitor/findings.js";
import { markerHash } from "../src/monitor/story.js";
import { SETUP } from "../src/remote/areas/setup.js";
import { areaHelp, LOCAL_WORDS } from "../src/remote/cli.js";
import { parseCmd, specProblems, type Cmd } from "../src/remote/spec.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { remoteWorld, type Ran, type RemoteWorld } from "./helpers/remote.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

// built at run time, so no file holds a token-shaped string
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);

let w: RemoteWorld;
let kc: FakeKeychain;
let kg: FakeKeygen;
let ann: string;
const seen: string[] = [];

/** Runs a command of this area and keeps what it printed, to check at the end that no secret was shown. */
async function scf(words: string[], o: { as?: string; answers?: string[]; tty?: boolean } = {}): Promise<Ran> {
  const r = await w.scf(words, { ...o, cmds: SETUP });
  seen.push(r.out);
  return r;
}
const cmd = (area: string, action: string): Cmd => SETUP.find((c) => c.area === area && c.action === action)!;
const callOf = (area: string, action: string, words: string[]) => parseCmd(cmd(area, action), words).call;
const idIn = (out: string) => /^id:\s+(\S+)$/m.exec(out)![1]!;

beforeAll(async () => {
  kc = fakeKeychain();
  kg = fakeKeygen();
  w = await remoteWorld();
  ann = await w.signIn("ann@example.com");
});
afterAll(() => {
  w.close();
  kg.remove();
  kc.remove();
});

describe("the table", () => {
  it("names only calls the server knows", () => {
    expect(specProblems(SETUP)).toEqual([]);
  });

  it("keeps clear of the file commands and never takes a secret as a word", () => {
    // `scf monitor on|off|status` stay with the file command
    expect(SETUP.filter((c) => c.area === "monitor" && ["on", "off", "status"].includes(c.action))).toEqual([]);
    expect([...new Set(SETUP.map((c) => c.area))].filter((a) => LOCAL_WORDS.includes(a)).sort()).toEqual(["blocks", "flows", "monitor"]);
    for (const c of SETUP) {
      const words = [...(c.args ?? []), ...Object.keys(c.flags ?? {})];
      expect(words.filter((x) => /token|key|secret|password/i.test(x)), `${c.area} ${c.action}`).toEqual([]);
    }
    for (const c of SETUP.filter((x) => x.prompts)) expect(c.prompts).toEqual([{ field: "token", label: "Access token", hidden: true }]);
    expect(areaHelp(SETUP, "settings")).toContain("REPLACE all settings");
  });

  it("asks before what cannot be taken back", () => {
    const asks = SETUP.filter((c) => c.confirm).map((c) => `${c.area} ${c.action}`);
    expect(asks).toEqual([
      "repos use-token", "repos use-https-token", "repos use-key", "repos new-key", "repos use-app", "repos use-server-login", "repos remove", "repos remove-github",
      "settings set", "monitor mute-for-good", "monitor mute-detector-for-good", "flows save", "flows remove", "blocks save", "blocks remove",
    ]);
  });

  it("builds the calls that need GitHub, an agent or a second host", () => {
    expect(callOf("repos", "test", ["r1"])).toEqual({ method: "POST", path: "repos/r1/test", body: {} });
    expect(callOf("repos", "add-app", ["https://github.com/acme/app"])).toEqual({ method: "POST", path: "repos", body: { method: "github-app", url: "https://github.com/acme/app" } });
    expect(callOf("repos", "use-app", ["r1", "--yes"])).toEqual({ method: "PUT", path: "repos/r1/auth", body: { method: "github-app" } });
    expect(callOf("repos", "add-https-token", ["https://git.example.test/a/b", "--username", "ann"])).toEqual({ method: "POST", path: "repos", body: { method: "https-token", url: "https://git.example.test/a/b", username: "ann" } });
    expect(() => callOf("repos", "add-https-token", ["https://git.example.test/a/b"])).toThrow("--username is needed");
    expect(callOf("repos", "use-https-token", ["r1"])).toEqual({ method: "PUT", path: "repos/r1/auth", body: { method: "https-token" } });
    expect(callOf("repos", "remove-github", ["acme", "app"])).toEqual({ method: "DELETE", path: "repos/acme/app" });
    expect(callOf("providers", "test", ["claude:sonnet"])).toEqual({ method: "POST", path: "providers/test", body: { spec: "claude:sonnet" } });
    expect(callOf("flows", "generate", ["a flow that says hello", "--current", "name: x\n"])).toEqual({ method: "POST", path: "generate", body: { request: "a flow that says hello", current: "name: x\n" } });
    expect(callOf("flows", "list", ["--published"])).toEqual({ method: "GET", path: "flows", query: { published: "1" } });
    expect(callOf("monitor", "story", ["0123456789abcdef"])).toEqual({ method: "POST", path: "monitor/story", body: { finding: "0123456789abcdef" } });
    expect(callOf("monitor", "mute-detector", ["slow-step", "--reason", "noise", "--hours", "2"])).toEqual({ method: "POST", path: "monitor/mutes", body: { detector: "slow-step", reason: "noise", hours: 2 } });
    expect(() => callOf("monitor", "mute", ["0123456789abcdef", "--reason", "r"])).toThrow("--hours is needed");
  });
});

describe("repositories", () => {
  let tokenRepo: string;
  let keyRepo: string;

  it("adds one without a sign-in, one with a token that is asked for, and one with a deploy key", async () => {
    expect((await scf(["repos", "list"], { as: ann })).out).toBe("no repositories");
    const plain = await scf(["repos", "add", "https://github.com/acme/web"], { as: ann });
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/^method:\s+none$/m);

    const t = await scf(["repos", "add-token", "https://github.com/Acme/App"], { as: ann, answers: [TOKEN] });
    expect(t.code).toBe(0);
    expect(t.out).toMatch(/^method:\s+github-token$/m);
    expect(t.out).toMatch(/^github:\s+acme\/app$/m);
    tokenRepo = idIn(t.out);
    // no token given: nothing is sent
    await expect(scf(["repos", "add-token", "https://github.com/acme/other"], { as: ann })).rejects.toThrow("access token is needed");

    const k = await scf(["repos", "add-key", "git@github.com:acme/tool.git"], { as: ann });
    expect(k.code).toBe(0);
    expect(k.out).toContain("Public key (add it as a deploy key with write access):");
    expect(k.out).toContain(kg.pairs()[0]!.publicKey.trim());
    keyRepo = idIn(k.out);
  });

  it("lists them, shows one, the methods and the Definition of Ready", async () => {
    const list = await scf(["repos", "list"], { as: ann });
    expect(list.out.split("\n")[0]).toMatch(/^ID\s+URL\s+METHOD\s+CONNECTION$/);
    expect(list.out.split("\n")).toHaveLength(4);
    expect(list.out).toMatch(new RegExp(`${tokenRepo}\\s+https://github.com/Acme/App\\s+github-token\\s+not tested`));
    expect((await scf(["repos", "list", "--json"], { as: ann })).json<unknown[]>()).toHaveLength(3);
    // another account sees none of them
    expect((await scf(["repos", "list"])).out).toBe("no repositories");

    const one = await scf(["repos", "show", keyRepo], { as: ann });
    expect(one.out).toMatch(/^method:\s+ssh-deploy-key$/m);
    expect(one.out).toMatch(/^connection:\s+not tested$/m);
    expect(one.out).toContain(kg.pairs()[0]!.publicKey.trim());
    expect((await scf(["repos", "show", "nope"], { as: ann })).out).toBe("no repository with the id nope");

    expect((await scf(["repos", "methods"], { as: ann })).out).toBe("methods:    github-token, https-token, ssh-deploy-key\ngithub app: not set up");
    expect((await scf(["repos", "methods"])).out).toContain("methods:    none, github-token");
    const ready = await scf(["repos", "ready", tokenRepo], { as: ann });
    expect(ready.out.split("\n").slice(0, 2)).toEqual(["the default list", "ID                 TEXT"]);
    expect(ready.out).toContain("no-open-questions  there are no open questions");
  });

  it("replaces a sign-in only after a yes, and takes the new token from the prompt", async () => {
    await expect(scf(["repos", "use-token", tokenRepo], { as: ann, answers: [TOKEN2] })).rejects.toThrow("cannot be read back. Add --yes to do it without a question.");
    expect(await scf(["repos", "use-token", tokenRepo], { as: ann, tty: true, answers: ["no"] })).toMatchObject({ code: 1, out: "nothing was changed" });
    const before = (await scf(["repos", "list", "--json"], { as: ann })).json<{ id: string; credentialId?: string }[]>().find((r) => r.id === tokenRepo)!;
    const r = await scf(["repos", "use-token", tokenRepo, "--yes", "--json"], { as: ann, answers: [TOKEN2] });
    expect(r.code).toBe(0);
    expect(r.json<{ credentialId: string }>().credentialId).not.toBe(before.credentialId);

    // a new key for the deploy-key repository: another public key is shown
    const k = await scf(["repos", "new-key", keyRepo, "--yes"], { as: ann });
    expect(k.out).toContain(kg.pairs()[1]!.publicKey.trim());
    // the address may change to another form of the same repository only
    expect((await scf(["repos", "set-url", tokenRepo, "https://github.com/acme/app.git"], { as: ann })).code).toBe(0);
    const other = await scf(["repos", "set-url", tokenRepo, "https://github.com/acme/else"], { as: ann });
    expect([other.code, other.err]).toEqual([1, "error: that is another repository; the address can only change to another form of the same one"]);
  });

  it("refuses the server's own access for a user, and another account's repository", async () => {
    const r = await scf(["repos", "use-server-login", tokenRepo, "--yes"], { as: ann });
    expect([r.code, r.err.startsWith("error: only an admin")]).toEqual([4, true]);
    // the admin does not own it: unknown, like any other id
    expect(await scf(["repos", "remove", tokenRepo, "--yes"])).toMatchObject({ code: 1, err: "error: no such repository" });
  });

  it("removes a repository after a yes, by id or by its GitHub name", async () => {
    await expect(scf(["repos", "remove", keyRepo], { as: ann })).rejects.toThrow("are removed. Add --yes to do it without a question.");
    expect((await scf(["repos", "remove", keyRepo, "--yes"], { as: ann })).code).toBe(0);
    expect((await scf(["repos", "remove-github", "acme", "web", "--yes"], { as: ann })).code).toBe(0);
    const left = (await scf(["repos", "list", "--json"], { as: ann })).json<{ id: string }[]>();
    expect(left.map((r) => r.id)).toEqual([tokenRepo]);
  });

  it("never printed a token or a private key", () => {
    const all = seen.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN2);
    for (const p of kg.pairs()) expect(all).not.toContain(p.privateKey.trim());
    expect(all).not.toContain("PRIVATE KEY");
  });
});

describe("settings and providers", () => {
  it("shows the settings and replaces them as a whole", async () => {
    const cfg = (await scf(["settings", "show"])).json<Record<string, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfg).toEqual((await scf(["settings", "show", "--json"])).json());
    expect(cfg.monitor.report_limits.per_day).toBeTypeOf("number");
    const next = { ...cfg, monitor: { ...cfg.monitor, report_limits: { ...cfg.monitor.report_limits, per_day: cfg.monitor.report_limits.per_day + 1 } } };
    await expect(scf(["settings", "set", "--data", JSON.stringify(next)])).rejects.toThrow("goes back to its default. Add --yes to do it without a question.");
    const saved = await scf(["settings", "set", "--yes", "--json", "--data", JSON.stringify(next)]);
    expect(saved.code).toBe(0);
    expect(saved.json()).toEqual(next);
    expect((await scf(["settings", "show", "--json"])).json()).toEqual(next);
    expect((await scf(["monitor", "show", "--json"])).json<{ perDay: number }>().perDay).toBe(next.monitor.report_limits.per_day);
    const bad = await scf(["settings", "set", "--yes", "--data", '{"monitor":"nope"}']);
    expect([bad.code, bad.err.startsWith("error: invalid config: ")]).toEqual([1, true]);
    expect((await scf(["settings", "show", "--json"])).json()).toEqual(next);
  });

  it("is closed to a normal user", async () => {
    for (const words of [["settings", "show"], ["providers", "list"], ["monitor", "show"], ["flows", "show", "issue-plan"], ["blocks", "list"]]) {
      const r = await scf(words, { as: ann });
      expect([r.code, r.err.startsWith("error: ")], words.join(" ")).toEqual([4, true]);
    }
  });

  it("lists the agents and the providers", async () => {
    const r = await scf(["providers", "list"]);
    expect(r.code).toBe(0);
    const [agents, providers] = r.out.split("\n\n");
    expect(agents!.split("\n")[0]).toMatch(/^AGENT\s+INSTALLED\s+SIGNED IN\s+VERSION\s+DETAIL$/);
    expect(agents).toMatch(/^claude\s+(yes|no)/m);
    expect(providers!.split("\n")[0]).toMatch(/^NAME\s+KIND\s+WORKS\s+AGENTS\s+MODELS\s+DETAIL$/);
    const empty = await scf(["providers", "test", " "]);
    expect([empty.code, empty.err]).toEqual([1, "error: spec required"]);
  });
});

describe("the monitor", () => {
  const A = "restart-loop|a";
  const finding = (fingerprint: string): Finding => ({
    detector: "restart-loop", fingerprint, severity: "critical", summary: `sentence of ${markerHash(fingerprint)}`, about: "foundry", evidence: {},
    firstSeen: new Date(Date.now() - 3_600_000).toISOString(), lastSeen: new Date().toISOString(), count: 3, gone: false,
  });
  const a = markerHash(A);

  it("shows the state, the findings, the detectors and one finding", async () => {
    saveFindings([finding(A)], join(process.env.FACTORY_HOME!, "monitor-findings.json"));
    const state = await scf(["monitor", "show"]);
    expect(state.out).toMatch(/^state:\s+\S+/m);
    expect(state.out).toContain("findings: 1\nmutes:    0");
    const list = await scf(["monitor", "findings"]);
    expect(list.out.split("\n")[0]).toMatch(/^ID\s+STATE\s+SEVERITY\s+DETECTOR\s+COUNT\s+LASTSEEN\s+SUMMARY$/);
    expect(list.out).toMatch(new RegExp(`^${a}\\s+seen\\s+critical\\s+restart-loop\\s+3\\s`, "m"));
    expect(list.out).not.toContain(A);
    expect((await scf(["monitor", "detectors"])).out).toMatch(/^slow-step\b/m);
    expect((await scf(["monitor", "mutes"])).out).toBe("no mutes");
    expect((await scf(["monitor", "finding", a])).out).toBe(`finding ${a}\n\nno bug stories\n\nno runs`);
    expect(await scf(["monitor", "finding", "nope"])).toMatchObject({ code: 1, err: "error: unknown finding" });
  });

  it("mutes for a time without a question and for good only after a yes; unmute ends it", async () => {
    const timed = await scf(["monitor", "mute", a, "--reason", "known noise", "--hours", "2"]);
    expect(timed.out).toMatch(/^muted \(id \S+\) until \d{4}-/);
    const id = /id (\S+)\)/.exec(timed.out)![1]!;
    expect((await scf(["monitor", "mutes"])).out).toMatch(new RegExp(`^${id}\\s+finding\\s+restart-loop\\s+${a}\\s+\\d{4}-\\S+\\s+known noise$`, "m"));
    expect((await scf(["monitor", "findings"])).out).toMatch(new RegExp(`^${a}\\s+muted`, "m"));
    expect((await scf(["monitor", "unmute", id])).out).toBe("the mute has ended\nno mutes");
    expect((await scf(["monitor", "unmute", id])).code).toBe(1);

    await expect(scf(["monitor", "mute-detector-for-good", "slow-step", "--reason", "too loud"])).rejects.toThrow("Add --yes to do it without a question.");
    const good = await scf(["monitor", "mute-detector-for-good", "slow-step", "--reason", "too loud", "--yes"]);
    expect(good.out).toMatch(/^muted \(id \S+\) for good$/);
    expect((await scf(["monitor", "mutes"])).out).toMatch(/\sdetector\s+slow-step\s+for good\s+too loud$/m);
    expect((await scf(["monitor", "unmute", /id (\S+)\)/.exec(good.out)![1]!])).code).toBe(0);
    expect((await scf(["monitor", "mute-for-good", a, "--reason", "r", "--yes", "--json"])).json<{ mute: { finding: string; until?: string } }>().mute).toMatchObject({ finding: a });
  });

  it("switches the bug stories off and on, and answers what cannot be done", async () => {
    const off = await scf(["monitor", "stop-stories"]);
    expect(off.out).toMatch(/^bug stories are switched off\nstate:\s+off$/m);
    expect((await scf(["monitor", "stop-stories"])).out).toContain("bug stories were off already");
    expect((await scf(["monitor", "start-stories"])).out).toContain("bug stories are switched on");
    expect((await scf(["monitor", "show", "--json"])).json<{ state: string }>().state).not.toBe("off");
    const retry = await scf(["monitor", "retry", a]);
    expect([retry.code, retry.err]).toEqual([1, "error: this finding does not wait for a person"]);
    const story = await scf(["monitor", "story", "0123456789abcdef"]);
    expect([story.code, story.err]).toEqual([1, "error: unknown finding"]);
  });
});

describe("flows and blocks", () => {
  const flow = (name: string) => `name: ${name}\ndescription: says hello\nsteps:\n  - id: hello\n    type: shell\n    run: echo hello\n`;

  it("lists and prints the flows, for an admin and as a user sees them", async () => {
    const list = await scf(["flows", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^NAME\s+SCOPE\s+PUBLISHED\s+DESCRIPTION$/);
    expect(list.out).toMatch(/^issue-plan\s+builtin\b/m);
    expect((await scf(["flows", "show", "issue-plan"])).out).toMatch(/^name: issue-plan$/m);
    expect((await scf(["flows", "show", "no-such-flow"])).code).toBe(1);
    const mine = (await scf(["flows", "list", "--json"], { as: ann })).json<unknown[]>();
    expect((await scf(["flows", "list", "--published", "--json"])).json()).toEqual(mine);
    expect((await scf(["flows", "list"], { as: ann })).out).toMatch(mine.length ? /^NAME\s+VERSION\s+TITLE/ : /^no flows$/);
    expect((await scf(["flows", "evals"])).out).toBe("no eval reports");
  });

  it("checks, saves and removes a flow", async () => {
    expect((await scf(["flows", "check", flow("hello-cli")])).out).toBe("ok: hello-cli");
    const bad = await scf(["flows", "check", "name: hello-cli\nsteps: []\n"]);
    expect(bad.code).toBe(0);
    expect(bad.out).toMatch(/^not valid: /);
    expect(bad.out).toMatch(/^ {2}steps: /m);

    expect(() => callOf("flows", "save", ["hello-cli", flow("hello-cli")])).toThrow("--scope is needed");
    expect((await scf(["flows", "save", "hello-cli", flow("hello-cli"), "--scope", "repo"])).out).toBe("saved hello-cli (repo)");
    expect((await scf(["flows", "show", "hello-cli"])).out).toBe(flow("hello-cli").trimEnd());
    // a second save replaces the file: that is asked first; in the other scope nothing is replaced
    await expect(scf(["flows", "save", "hello-cli", flow("hello-cli"), "--scope", "repo"])).rejects.toThrow("A flow with this name is saved there already: its file is replaced. Add --yes to do it without a question.");
    expect((await scf(["flows", "save", "hello-cli", flow("hello-cli"), "--scope", "repo", "--yes"])).out).toBe("saved hello-cli (repo)");
    expect((await scf(["flows", "list"])).out).toMatch(/^hello-cli\s+repo\s+no\s+says hello$/m);
    const other = await scf(["flows", "save", "other-name", flow("hello-cli"), "--scope", "repo"]);
    expect([other.code, other.err]).toEqual([1, 'error: flow name "hello-cli" must match "other-name"']);

    await expect(scf(["flows", "remove", "hello-cli"])).rejects.toThrow("The file of this flow is deleted. Add --yes to do it without a question.");
    expect((await scf(["flows", "remove", "hello-cli", "--yes"])).out).toMatch(/^deleted .*hello-cli\.yaml$/);
    expect((await scf(["flows", "show", "hello-cli"])).code).toBe(1);
    const builtin = await scf(["flows", "remove", "issue-plan", "--yes"]);
    expect([builtin.code, builtin.err]).toEqual([4, "error: built-in flows cannot be deleted"]);
  });

  it("lists, prints, saves and removes a block", async () => {
    const list = await scf(["blocks", "list"]);
    expect(list.out.split("\n")[0]).toMatch(/^ID\s+SCOPE\s+NAME$/);
    expect(list.out).toMatch(/^commit\s+builtin\s+\S/m);
    const yaml = (await scf(["blocks", "show", "commit"])).out;
    expect(yaml).toMatch(/^name: /m);
    expect((await scf(["blocks", "show", "no-such-block"])).out).toBe("no block with the id no-such-block");

    expect((await scf(["blocks", "save", "commit-cli", yaml, "--scope", "repo"])).out).toBe("saved commit-cli (repo)");
    await expect(scf(["blocks", "save", "commit-cli", yaml, "--scope", "repo"])).rejects.toThrow("A block with this id is saved there already: its file is replaced. Add --yes to do it without a question.");
    expect((await scf(["blocks", "list"])).out).toMatch(/^commit-cli\s+repo\s/m);
    await expect(scf(["blocks", "remove", "commit-cli"])).rejects.toThrow("The file of this block is deleted. Add --yes to do it without a question.");
    expect((await scf(["blocks", "remove", "commit-cli", "--yes"])).out).toMatch(/^deleted .*commit-cli\.yaml$/);
    expect((await scf(["blocks", "show", "commit-cli"])).out).toBe("no block with the id commit-cli");
  });
});
