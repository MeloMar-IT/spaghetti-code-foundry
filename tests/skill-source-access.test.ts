import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { listAllRepos, reposPath, type RepoRecord } from "../src/auth/repos.js";
import { ACCESS_NOT_APP, ACCESS_NOT_REGISTERED, accessProblem, accessRecord, sameDestination, sourceCredential } from "../src/skill-import/source-access.js";
import { skillsCommand } from "../src/skills/cli.js";

const SECRET = "ghs_" + "A1b2C3d4E5f6G7h8I9j0";
const KEY = "github.com/acme/skills";
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rec = (over: Partial<RepoRecord> & { n?: number } = {}): RepoRecord => {
  const { n = 1, ...rest } = over;
  return { id: UUID(n), owner: UUID(99), url: "https://github.com/acme/skills", method: "github-app", installationId: "77", added: "2026-01-01T00:00:00.000Z", ...rest };
};

describe("accessProblem", () => {
  it("gives a fixed sentence when no repository is registered or another one is", () => {
    expect(accessProblem({ repositoryKey: KEY }, [])).toBe(ACCESS_NOT_REGISTERED);
    expect(accessProblem({ repositoryKey: KEY }, [rec({ url: "https://github.com/acme/other" })])).toBe(ACCESS_NOT_REGISTERED);
  });

  it("refuses a deploy key, a token and no sign-in", () => {
    const key = rec({ method: "ssh-deploy-key", url: "ssh://git@github.com/acme/skills", installationId: undefined });
    const none = rec({ method: "none", installationId: undefined });
    for (const r of [key, none]) expect(accessProblem({ repositoryKey: KEY }, [r])).toBe(ACCESS_NOT_APP);
  });

  it("accepts a GitHub App record, ignoring case and a .git suffix", () => {
    expect(accessProblem({ repositoryKey: KEY }, [rec()])).toBeUndefined();
    expect(accessProblem({ repositoryKey: KEY }, [rec({ url: "https://github.com/Acme/Skills.git" })])).toBeUndefined();
  });

  it("takes the oldest GitHub App record", () => {
    const r = accessRecord({ repositoryKey: KEY }, [rec({ n: 2, installationId: "2", added: "2026-02-01T00:00:00.000Z" }), rec({ n: 1, installationId: "1" })]);
    expect("record" in r && r.record.installationId).toBe("1");
  });
});

describe("sourceCredential", () => {
  const source = { repositoryKey: KEY, access: { repo: "acme/skills" } };

  it("reads nothing for a source without access", async () => {
    let called = 0;
    const r = await sourceCredential({ repositoryKey: KEY }, { repos: () => (called++, []), token: async () => (called++, { ok: false, reason: "x" }) });
    expect(r).toEqual({ ok: true });
    expect(called).toBe(0);
  });

  it("asks for a read-only token of that one repository", async () => {
    const seen: unknown[] = [];
    const r = await sourceCredential(source, {
      repos: () => [rec()],
      config: () => ({ github_app: undefined }) as never,
      token: async (...a) => (seen.push(a[0], a[3]), { ok: true, token: SECRET, expires: 1 }),
    });
    expect(r).toEqual({ ok: true, credential: { username: "x-access-token", password: SECRET } });
    expect(seen[0]).toEqual({ kind: "app", installationId: "77", url: "https://github.com/acme/skills", github: "acme/skills" });
    expect(seen[1]).toEqual({ contents: "read" });
  });

  it("asks for the permissions it is given", async () => {
    const seen: unknown[] = [];
    await sourceCredential(source, {
      repos: () => [rec()],
      config: () => ({ github_app: undefined }) as never,
      permissions: { issues: "write" },
      token: async (...a) => (seen.push(a[3]), { ok: true, token: SECRET, expires: 1 }),
    });
    expect(seen).toEqual([{ issues: "write" }]);
  });

  it("turns a token failure into the fixed sentence", async () => {
    const r = await sourceCredential(source, { repos: () => [rec()], config: () => ({}) as never, token: async () => ({ ok: false, reason: "the sentence" }) });
    expect(r).toEqual({ ok: false, problem: "the sentence" });
  });

  it("refuses a token with a newline or odd characters, and never prints it", async () => {
    for (const token of [SECRET + "\nx", "a b", ""]) {
      const r = await sourceCredential(source, { repos: () => [rec()], config: () => ({}) as never, token: async () => ({ ok: true, token, expires: 1 }) });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  it("gives a fixed sentence when the token function throws or the list cannot be read", async () => {
    const boom = await sourceCredential(source, { repos: () => [rec()], config: () => ({}) as never, token: async () => { throw new Error(SECRET); } });
    expect(boom.ok).toBe(false);
    expect(JSON.stringify(boom)).not.toContain(SECRET);
    const none = await sourceCredential(source, { repos: () => { throw new Error("x"); } });
    expect(none).toEqual({ ok: false, problem: ACCESS_NOT_REGISTERED });
  });
});

describe("sameDestination", () => {
  it("needs the same repository and the same access", () => {
    const a = { repositoryKey: KEY, access: { repo: "acme/skills" } };
    expect(sameDestination(a, { ...a })).toBe(true);
    expect(sameDestination(a, { repositoryKey: "github.com/evil/skills", access: a.access })).toBe(false);
    expect(sameDestination(a, { repositoryKey: KEY })).toBe(false);
    expect(sameDestination({ repositoryKey: KEY }, a)).toBe(false);
  });
});

describe("scf skills sources check with access", () => {
  const entry = {
    id: "acme-skills",
    repository: "https://github.com/acme/skills",
    status: "disabled",
    reason: "waiting for the first approved commit",
    ref: { track: "main" },
    paths: ["skills"],
    exclude: ["skills/example-skill"],
    adapter: "agent-skills",
    trust: "first-party",
    licence: { allow: ["MIT"] },
    update: { cadence: "daily" },
    access: { repo: "acme/skills" },
    owner: "@octocat",
  };
  const run = async (records: RepoRecord[]) => {
    const d = mkdtempSync(join(tmpdir(), "scf-access-cli-"));
    writeFileSync(join(d, "list.yaml"), stringify({ schema: 1, sources: [entry] }));
    writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: records }));
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["sources", "check", "list.yaml"], values: {} }, (l) => lines.push(l), { cwd: d, repos: listAllRepos });
    return { code, lines };
  };

  it("prints OK for a registered GitHub App repository", async () => {
    const r = await run([rec()]);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe("OK 1 sources, 0 enabled");
  });

  it("prints a PROBLEM naming access when the repository is not registered", async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`PROBLEM sources[0] (acme-skills) access: ${ACCESS_NOT_REGISTERED}`);
  });

  it("prints a PROBLEM naming access for another method", async () => {
    const r = await run([rec({ method: "none", installationId: undefined })]);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain(`access: ${ACCESS_NOT_APP}`);
  });
});
