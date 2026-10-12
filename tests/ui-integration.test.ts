import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const m: any = await import("../ui/integration.js" as string);

const OPTIONS = { methods: ["github-app"], githubApp: { available: true, installUrl: "https://github.com/apps/foundry-bot/installations/new" } };
const check = (name: string, ok: boolean, extra: object = {}) => ({ check: name, ok, message: "m", ...extra });
const repo = (over: object = {}) => ({ id: "r1", owner: "u1", url: "https://github.com/o/a", method: "github-token", ...over });
const identity = (over: object, opts: object = {}) => m.integrationOf(repo(over), opts).identity;

describe("providerOf", () => {
  it("is GitHub for github.com in any form", () => {
    for (const url of ["https://github.com/o/a", "git@github.com:o/a.git", "ssh://git@github.com/o/a", "https://user@GitHub.com/o/a"]) expect(m.providerOf(url), url).toBe("GitHub");
  });

  it("is the host name for another host", () => {
    expect(m.providerOf("ssh://git@git.example.org:22/x")).toBe("git.example.org");
    expect(m.providerOf("https://user@gitlab.example.com/x")).toBe("gitlab.example.com");
    expect(m.providerOf("git@Host.Example:path/x.git")).toBe("host.example");
  });

  it("is Unknown host for no address", () => {
    for (const v of ["", "  ", undefined, null, 5]) expect(m.providerOf(v), String(v)).toBe("Unknown host");
  });
});

describe("identity", () => {
  it("names the app with its slug, and without when the slug is not known", () => {
    expect(identity({ method: "github-app" }, { options: OPTIONS })).toBe("GitHub App foundry-bot");
    expect(identity({ method: "github-app" })).toBe("GitHub App");
    expect(identity({ method: "github-app" }, { options: { githubApp: { available: false } } })).toBe("GitHub App");
    expect(m.appSlug({ githubApp: { installUrl: "https://evil.example/apps/x/installations/new" } })).toBe("");
  });

  it("names the user of a token, or only the token", () => {
    expect(identity({ method: "https-token", username: "ann" })).toBe("token of ann");
    expect(identity({ method: "https-token" })).toBe("token");
    expect(identity({ method: "github-token" })).toBe("fine-grained token");
  });

  it("names a deploy key by type and comment, never by the key", () => {
    const body = "AAAAC3NzaC1lZDI1NTE5AAAAIsecretkeybody";
    expect(identity({ method: "ssh-deploy-key", publicKey: `ssh-ed25519 ${body}` })).toBe("deploy key ssh-ed25519");
    expect(identity({ method: "ssh-deploy-key", publicKey: `ssh-ed25519 ${body} foundry key` })).toBe("deploy key ssh-ed25519 foundry key");
    expect(identity({ method: "ssh-deploy-key" })).toBe("deploy key");
    expect(identity({ method: "ssh-deploy-key", publicKey: `ssh-ed25519 ${body}` })).not.toContain(body);
  });

  it("reads none as the server's own access for an admin and as a need for a user", () => {
    expect(identity({ method: "none" }, { admin: true })).toBe("the server's own access");
    expect(identity({ method: "none" })).toBe("Needs authentication");
  });

  it("shows an unknown method as it comes", () => {
    expect(identity({ method: "magic" })).toBe("magic");
  });
});

describe("scope", () => {
  const scope = (connection: unknown) => m.integrationOf(repo({ connection })).scope;
  const states = (connection: unknown) => scope(connection).map((s: any) => `${s.name} ${s.state}`);

  it("is not checked everywhere without a connection test", () => {
    expect(states(undefined)).toEqual(["Read not checked", "Write not checked", "GitHub API not checked"]);
  });

  it("reads works and failed from the checks", () => {
    expect(states({ ok: true, checks: [check("clone", true), check("push", true), check("github-api", true)] })).toEqual(["Read works", "Write works", "GitHub API works"]);
    expect(states({ ok: false, checks: [check("clone", true), check("push", false), check("github-api", false)] })).toEqual(["Read works", "Write failed", "GitHub API failed"]);
  });

  it("reads a skipped check and a missing check as not checked", () => {
    expect(states({ ok: false, checks: [check("clone", false), check("push", false, { skipped: true })] })).toEqual(["Read failed", "Write not checked", "GitHub API not checked"]);
  });

  it("tolerates checks that are not a list", () => {
    expect(states({ ok: true, checks: "x" })).toEqual(["Read not checked", "Write not checked", "GitHub API not checked"]);
  });
});

describe("bound", () => {
  it("is limited to this repository for a deploy key and the app only", () => {
    const bound = (method: string) => m.integrationOf(repo({ method })).bound;
    expect(bound("ssh-deploy-key")).toBe("limited to this repository");
    expect(bound("github-app")).toBe("limited to this repository");
    for (const method of ["github-token", "https-token", "none"]) expect(bound(method), method).toBe("");
  });
});

describe("integrationBlock", () => {
  it("gives Provider, Identity and Scope", () => {
    const items = m.integrationBlock(m.integrationOf(repo({ method: "https-token", username: "ann", url: "https://git.example.org/x" })));
    expect(items).toEqual([
      { label: "Provider", value: "git.example.org" },
      { label: "Identity", value: "token of ann" },
      { label: "Scope", value: "Read not checked, Write not checked, GitHub API not checked" },
    ]);
  });

  it("ends the scope with the restriction of a deploy key", () => {
    const conn = { ok: true, checks: [check("clone", true), check("push", true), check("github-api", true)] };
    expect(m.integrationBlock(m.integrationOf(repo({ method: "github-app", connection: conn })))[2].value).toBe("Read works, Write works, GitHub API works, limited to this repository");
  });

  it("gives a dash for an empty scope", () => {
    expect(m.integrationBlock({ provider: "p", identity: "i", scope: [], bound: "" })[2].value).toBe("—");
  });
});

describe("credentialIntegration", () => {
  const cred = (over: object = {}) => ({ id: "c1", type: "token", name: "repo:r1", owner: "u1", ...over });

  it("is the integration of the repository of repo:<id>", () => {
    expect(m.credentialIntegration(cred(), [repo({ method: "https-token", username: "ann" })]).identity).toBe("token of ann");
  });

  it("does not match a repository of another owner", () => {
    expect(m.credentialIntegration(cred({ owner: "u2" }), [repo()])).toMatchObject({ provider: "No repository", identity: "token repo:r1" });
  });

  it("falls back for a credential without a repository", () => {
    expect(m.credentialIntegration(cred({ name: "gh" }), [repo()])).toEqual({ provider: "No repository", identity: "token gh", scope: [], bound: "" });
  });

  it("says the details are unavailable when the repositories are not a list", () => {
    for (const repos of [null, undefined, "x"]) expect(m.credentialIntegration(cred(), repos), String(repos)).toMatchObject({ provider: "Unavailable", identity: "Details unavailable (token repo:r1)" });
  });
});

describe("the module", () => {
  it("has no import and no call for credentials", () => {
    const src = readFileSync(new URL("../ui/integration.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toContain("allCredentials");
  });
});
