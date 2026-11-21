import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RepoAccess } from "../src/auth/repos.js";
import { ConfigSchema } from "../src/config.js";
import { RunPolicy } from "../src/engine/policy-hooks.js";
import {
  REF_FETCH_FAILED, REF_NO_ACCESS, REF_NO_SANDBOX, REF_PRIVATE, checkedReferences, clearVisibilityCache, githubVisibility, newestBatch, prepareReferences, referenceHold, referencePrompt, removeReferences, targetVisibility, type ReferenceDeps,
} from "../src/engine/reference-repos.js";
import type { ReferenceHold, RunSummary } from "../src/engine/state.js";
import { parsePolicyPack } from "../src/policy/parse.js";

const root = process.getuid?.() === 0;
let tmp: string;
let remote: string;
let head: string;
const savedRemote = process.env.SCF_CONNECT_REMOTE;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "reference-repos-"));
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "ROUTES.md"), "GET /v1/items\n");
  mkdirSync(join(seed, "docs"));
  writeFileSync(join(seed, "docs", "format.md"), "a format\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  head = git(seed, "rev-parse", "HEAD").trim();
  remote = join(tmp, "remote.git");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  process.env.SCF_CONNECT_REMOTE = remote;
});
afterAll(() => {
  if (savedRemote === undefined) delete process.env.SCF_CONNECT_REMOTE;
  else process.env.SCF_CONNECT_REMOTE = savedRemote;
  removeReferences(join(tmp, "run"));
  rmSync(tmp, { recursive: true, force: true });
});

let runDir: string;
let n = 0;
beforeEach(() => {
  runDir = join(tmp, `run-${++n}`);
  mkdirSync(runDir);
  clearVisibilityCache();
});
afterEach(() => {
  removeReferences(runDir);
});

const config = ConfigSchema.parse({});
const summary = (refs: unknown, over: Partial<RunSummary> = {}): RunSummary => ({ runDir, vars: { github_repo: "acme/app" }, owner: "u1", referenceRepos: refs, ...over }) as unknown as RunSummary;
const server: RepoAccess = { kind: "server" };
const deps = (over: ReferenceDeps = {}): ReferenceDeps => ({
  access: () => server,
  credential: () => "machine",
  visibility: async () => "public",
  targetVisibility: async () => "unknown",
  now: () => new Date("2026-11-15T10:00:00.000Z"),
  ...over,
});
const prepare = async (s: RunSummary, d: ReferenceDeps = deps(), policy?: Pick<RunPolicy, "at">, hold: ReferenceHold | "none" = "sandbox") => {
  const lines: string[] = [];
  await prepareReferences(s, config, { log: (l) => void lines.push(l), policy, hold: hold === "none" ? undefined : hold }, d);
  return lines;
};
const fails = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, stdio: "pipe" }).status !== 0;

describe("prepareReferences", { timeout: 30_000 }, () => {
  it("makes a locked copy of the default branch, without a remote, and records its commit", async () => {
    const s = summary({ repos: ["Acme/Lib"] });
    const lines = await prepare(s);
    const dir = join(runDir, "reference", "acme-lib");
    expect(readFileSync(join(dir, "ROUTES.md"), "utf8")).toBe("GET /v1/items\n");
    expect(s.references).toEqual([{ repo: "Acme/Lib", at: "2026-11-15T10:00:00.000Z", ok: true, commit: head, folder: "reference/acme-lib", held: "sandbox" }]);
    expect(lines).toEqual([`· reference Acme/Lib: commit ${head.slice(0, 12)} (read only, reference/acme-lib in the run folder; held: sandbox)`]);
    expect(git(dir, "remote").trim()).toBe("");
    if (root) return; // root ignores file modes
    expect(() => writeFileSync(join(dir, "ROUTES.md"), "changed")).toThrow();
    expect(() => writeFileSync(join(dir, "NEW.md"), "new")).toThrow();
    expect(() => writeFileSync(join(dir, "docs", "new.md"), "new")).toThrow();
    expect(() => writeFileSync(join(runDir, "reference", "other"), "x")).toThrow();
    expect(fails("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "x"], dir)).toBe(true);
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("holds a copy by file modes in an admin's run without the sandbox, and says so", async () => {
    const s = summary({ repos: ["acme/lib"] });
    const lines = await prepare(s, deps(), undefined, "file modes");
    expect(s.references![0]).toMatchObject({ ok: true, commit: head, held: "file modes" });
    expect(lines[0]).toMatch(/; held: file modes\)$/);
    if (!root) expect(() => writeFileSync(join(runDir, "reference", "acme-lib", "ROUTES.md"), "x")).toThrow();
  });

  it("referenceHold: the sandbox, or file modes for an admin only; a failed lookup counts as a user", () => {
    expect(referenceHold("on", "u1", (o) => o)).toBe("sandbox");
    expect(referenceHold("off", "a1", () => undefined)).toBe("file modes");
    expect(referenceHold("off", "u1", (o) => o)).toBeUndefined();
  });

  it("newestBatch: only the newest preparation, with valid names", () => {
    const rec = (repo: string, at: string) => ({ repo, at, ok: false });
    expect(newestBatch({ references: [rec("a/b", "1"), rec("a/c", "2"), rec("bad", "2")] }).map((r) => r.repo)).toEqual(["a/c"]);
    expect(newestBatch({})).toEqual([]);
  });

  it("makes no copy in a run without the OS sandbox: each reference is skipped with that reason, and no folder is made", async () => {
    let cloned = 0;
    const s = summary({ repos: ["acme/lib", "acme/api"] });
    const lines = await prepare(s, deps({ clone: async () => (cloned++, { ok: false, reason: "checkout-failed", detail: "x" }) }), undefined, "none");
    expect(cloned).toBe(0);
    expect(existsSync(join(runDir, "reference"))).toBe(false);
    expect(s.references!.map((r) => [r.repo, r.ok, r.reason])).toEqual([
      ["acme/lib", false, REF_NO_SANDBOX],
      ["acme/api", false, REF_NO_SANDBOX],
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^! reference acme\/lib: skipped — this run has no OS sandbox/);
  });

  it("does nothing without references, and never throws for a bad list", async () => {
    for (const refs of [undefined, { repos: [] }, ["acme/lib"], { repos: ["bad"] }]) {
      const s = summary(refs);
      expect(await prepare(s)).toEqual([]);
      expect(s.references).toBeUndefined();
    }
    expect(existsSync(join(runDir, "reference"))).toBe(false);
  });

  it("skips one the owner cannot use and one that cannot be fetched, and still makes the others", async () => {
    let cloned = 0;
    const s = summary({ repos: ["acme/gone", "acme/broken", "acme/lib"] });
    const lines = await prepare(
      s,
      deps({
        access: (_o, r) => (r === "acme/gone" ? { kind: "refused", reason: '"acme/gone" is not one of your repositories' } : server),
        clone: async (o) => {
          cloned++;
          if (o.dir.endsWith("acme-broken")) return { ok: false, reason: "checkout-failed", detail: "x" };
          const { shallowClone } = await import("../src/preview/checkout.js");
          return shallowClone(o);
        },
      }),
    );
    expect(cloned).toBe(2);
    expect(s.references!.map((r) => [r.repo, r.ok, r.reason])).toEqual([
      ["acme/gone", false, `${REF_NO_ACCESS} ("acme/gone" is not one of your repositories)`],
      ["acme/broken", false, REF_FETCH_FAILED],
      ["acme/lib", true, undefined],
    ]);
    expect(lines.filter((l) => l.startsWith("! reference "))).toHaveLength(2);
    expect(lines[0]).toBe(`! reference acme/gone: skipped — ${REF_NO_ACCESS} ("acme/gone" is not one of your repositories)`);
    expect(existsSync(join(runDir, "reference", "acme-broken"))).toBe(false);
  });

  it("removes the leftovers of an earlier start and keeps the newest 50 records", async () => {
    const s = summary({ repos: ["acme/lib"] });
    s.references = Array.from({ length: 49 }, (_, i) => ({ repo: "acme/old", at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, ok: false }));
    await prepare(s);
    await prepare(s, deps({ now: () => new Date("2026-11-15T11:00:00.000Z") }));
    expect(s.references).toHaveLength(50);
    expect(s.references!.at(-1)!.at).toBe("2026-11-15T11:00:00.000Z");
    expect(readFileSync(join(runDir, "reference", "acme-lib", "ROUTES.md"), "utf8")).toContain("/v1/items");
  });

  it("asks the real policy at repository.access and skips a denied one without asking for access", async () => {
    const pack = parsePolicyPack({
      version: 1,
      policy: { id: "no-lib", version: "1" },
      mode: "observe",
      defaultOutcome: "allow",
      rules: [{ id: "deny-lib", boundaries: ["repository.access"], when: { repository: { in: ["acme/lib"] } }, outcome: "deny", reasonCode: "repository.not-allowed" }],
    });
    const asked: unknown[] = [];
    const policy = new RunPolicy({ runId: "r1", packs: [{ layer: "mandatory", id: "no-lib", pack }], base: {}, log: () => {} });
    const spy: Pick<RunPolicy, "at"> = { at: (b, f, st) => (asked.push(f), policy.at(b, f, st)) };
    // an observed deny is recorded, not enforced: the reference is still used
    const s = summary({ repos: ["Acme/Lib"] });
    await prepare(s, deps({ credential: () => "repository" }), spy);
    expect(asked).toEqual([{ repository: "acme/lib", credential: "repository" }]);
    expect(s.references![0]!.ok).toBe(true);
    // a mandatory policy that cannot be used denies a sign-in: the reference is skipped and access is never asked
    removeReferences(runDir);
    let accessed = 0;
    const broken = new RunPolicy({ runId: "r2", packs: [{ layer: "mandatory", id: "gone", problem: "policy.unavailable", detail: "no file" }], base: {}, log: () => {} });
    const s2 = summary({ repos: ["acme/lib"] });
    await prepare(s2, deps({ access: () => (accessed++, server) }), broken);
    expect(accessed).toBe(0);
    expect(s2.references![0]).toMatchObject({ ok: false, reason: expect.stringMatching(/^a policy refused access to it \(mandatory policy gone cannot be used/) });
  });

  it("gets an App token for an App repository, and skips it when that fails", async () => {
    const app: RepoAccess = { kind: "app", installationId: "7", url: "https://github.com/acme/lib", github: "acme/lib" };
    const seen: unknown[] = [];
    const clone: ReferenceDeps["clone"] = async (o) => (seen.push(o.source), { ok: false, reason: "checkout-failed", detail: "x" });
    const s = summary({ repos: ["acme/lib"] });
    await prepare(s, deps({ access: () => app, appToken: async () => ({ ok: true, token: "T0K", expires: 0 }), clone }));
    expect(seen).toEqual([{ kind: "remote", url: "https://github.com/acme/lib", auth: { method: "github-token", secret: "T0K" } }]);
    const s2 = summary({ repos: ["acme/lib"] });
    await prepare(s2, deps({ access: () => app, appToken: async () => ({ ok: false, reason: "the App is not installed" }), clone }));
    expect(seen).toHaveLength(1);
    expect(s2.references![0]).toMatchObject({ ok: false, reason: "the App is not installed" });
    expect(JSON.stringify([s.references, s2.references])).not.toContain("T0K");
  });
});

describe("the privacy rule", { timeout: 30_000 }, () => {
  const fake: ReferenceDeps["clone"] = async () => ({ ok: false, reason: "checkout-failed", detail: "x" });
  const decide = async (ref: "public" | "private" | "unknown", target: "private" | "unknown", privateOk = false) => {
    let targetAsked = 0;
    let refAsked = 0;
    const s = summary({ repos: ["acme/lib"], ...(privateOk ? { privateOk: true } : {}) });
    await prepare(s, deps({ visibility: async () => (refAsked++, ref), targetVisibility: async () => (targetAsked++, target), clone: fake }));
    const r = s.references![0]!;
    return { used: r.reason !== REF_PRIVATE, targetAsked, refAsked, reason: r.reason };
  };
  it("uses a public reference without asking about the target", async () => {
    expect(await decide("public", "unknown")).toMatchObject({ used: true, targetAsked: 0 });
  });
  it("uses a private reference only for a private target", async () => {
    expect((await decide("private", "private")).used).toBe(true);
    const skipped = await decide("private", "unknown");
    expect(skipped.used).toBe(false);
    expect(skipped.reason).toContain("reference_private_ok");
    expect((await decide("unknown", "unknown")).used).toBe(false);
    expect((await decide("unknown", "private")).used).toBe(true);
  });
  it("uses any reference with privateOk, with no visibility call", async () => {
    expect(await decide("private", "unknown", true)).toMatchObject({ used: true, refAsked: 0, targetAsked: 0 });
  });
  it("asks the target once per preparation, and again at the next one (a target that became public)", async () => {
    const answers: ("private" | "unknown")[] = ["private", "unknown"];
    let asked = 0;
    const s = summary({ repos: ["acme/a", "acme/b"] });
    const d = deps({ visibility: async () => "private", targetVisibility: async () => answers[asked++]!, clone: fake });
    await prepare(s, d);
    expect(asked).toBe(1);
    expect(s.references!.map((r) => r.reason)).toEqual([REF_FETCH_FAILED, REF_FETCH_FAILED]);
    await prepare(s, { ...d, now: () => new Date("2026-11-15T12:00:00.000Z") });
    expect(asked).toBe(2);
    expect(s.references!.slice(-2).map((r) => r.reason)).toEqual([REF_PRIVATE, REF_PRIVATE]);
  });
});

describe("removeReferences", () => {
  it("removes a locked copy, and is true when there is nothing", async () => {
    expect(removeReferences(runDir)).toBe(true);
    await prepare(summary({ repos: ["acme/lib"] }));
    expect(existsSync(join(runDir, "reference", "acme-lib", ".git"))).toBe(true);
    expect(removeReferences(runDir)).toBe(true);
    expect(existsSync(join(runDir, "reference"))).toBe(false);
  });
});

describe("referencePrompt", () => {
  const at1 = "2026-11-15T10:00:00.000Z";
  const at2 = "2026-11-15T11:00:00.000Z";
  const c = "a".repeat(40);
  it("lists the newest preparation only: the folders that are there, with path and commit, and the missing ones", () => {
    const dir = join(runDir, "reference", "acme-lib");
    mkdirSync(dir, { recursive: true });
    const p = referencePrompt({
      runDir,
      references: [
        { repo: "acme/old", at: at1, ok: true, commit: c, folder: "reference/acme-old" },
        { repo: "acme/lib", at: at2, ok: true, commit: c, folder: "reference/acme-lib" },
        { repo: "acme/gone", at: at2, ok: false, reason: "x" },
        { repo: "acme/vanished", at: at2, ok: true, commit: c, folder: "reference/acme-vanished" },
      ],
    })!;
    expect(p.text).toContain(`- acme/lib: ${dir} (commit ${c.slice(0, 12)})`);
    expect(p.text).toContain("Not available in this run: acme/gone, acme/vanished.");
    expect(p.text).not.toContain("acme/old");
    expect(p.text).toContain("owner_action");
    expect(p.text).toMatch(/Never change, commit or push/);
    expect(p.text).not.toContain("{{");
    expect(p.dirs[0]).toBe(dir);
  });
  it("is undefined without records", () => {
    expect(referencePrompt({ runDir })).toBeUndefined();
    expect(referencePrompt({ runDir, references: [] })).toBeUndefined();
  });
  it("names only the missing ones when none is there", () => {
    const p = referencePrompt({ runDir, references: [{ repo: "acme/gone", at: at1, ok: false }] })!;
    expect(p.text).toContain("Not available in this run: acme/gone.");
    expect(p.text).not.toContain("owner_action");
    expect(p.dirs).toEqual([]);
  });
});

describe("visibility", () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("is public only for a 200 with private false, and caches the answer for 10 minutes", async () => {
    let calls = 0;
    let t = 0;
    const f = (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe("https://api.github.com/repos/acme/lib");
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return new Response(JSON.stringify({ private: false }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await githubVisibility("acme/lib", f, () => t)).toBe("public");
    t = 9 * 60_000;
    expect(await githubVisibility("Acme/Lib", f, () => t)).toBe("public");
    expect(calls).toBe(1);
    t = 11 * 60_000;
    await githubVisibility("acme/lib", f, () => t);
    expect(calls).toBe(2);
  });
  it("is unknown for a 404, a 403, a private answer or a failed call", async () => {
    expect(await githubVisibility("acme/a", answer(404, {}))).toBe("unknown");
    expect(await githubVisibility("acme/b", answer(403, {}))).toBe("unknown");
    expect(await githubVisibility("acme/c", answer(200, { private: true }))).toBe("unknown");
    expect(await githubVisibility("acme/d", (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch)).toBe("unknown");
    expect(await githubVisibility("owner/repo", answer(200, { private: false }))).toBe("unknown");
  });
  it("judges the target private only on affirmative evidence", async () => {
    const tok: RepoAccess = { kind: "token", token: "T", url: "https://github.com/acme/app", username: "x-access-token" };
    const authed = (body: unknown, status = 200) =>
      (async (_u: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer T");
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const s = (repo: string) => ({ vars: { github_repo: repo }, owner: "u1" });
    expect(await targetVisibility(s("acme/app"), config, { access: () => tok, fetch: authed({ private: true }) })).toBe("private");
    expect(await targetVisibility(s("acme/app"), config, { access: () => tok, fetch: authed({ private: false }) })).toBe("unknown");
    expect(await targetVisibility(s("acme/app"), config, { access: () => tok, fetch: authed({}, 404) })).toBe("unknown");
    expect(await targetVisibility(s("acme/app"), config, { access: () => tok, fetch: (async () => Promise.reject(new Error("x"))) as unknown as typeof fetch })).toBe("unknown");
    expect(await targetVisibility(s("acme/app"), config, { access: () => ({ kind: "refused", reason: "no" }) })).toBe("unknown");
    expect(await targetVisibility(s("owner/repo"), config)).toBe("unknown");
    expect(await targetVisibility(s(""), config)).toBe("unknown");
    const local = "local:proj-0123abcd";
    expect(await targetVisibility(s(local), config, { findLocal: () => ({}) })).toBe("private");
    expect(await targetVisibility(s(local), config, { findLocal: () => ({ settings: { pushRemote: true } }) })).toBe("unknown");
    expect(await targetVisibility(s(local), config, { findLocal: () => undefined })).toBe("unknown");
  });
});

describe("checkedReferences", () => {
  it("accepts the saved object and refuses anything else", () => {
    expect(checkedReferences({ repos: ["acme/lib"], privateOk: true })).toEqual({ repos: ["acme/lib"], privateOk: true });
    expect(checkedReferences({ repos: ["acme/lib"], privateOk: false })).toEqual({ repos: ["acme/lib"] });
    for (const bad of [null, "acme/lib", ["acme/lib"], { repos: "acme/lib" }, { repos: [] }, { repos: Array.from({ length: 11 }, (_, i) => `a/r${i}`) }, { repos: ["bad"] }, { repos: ["a/b", "A/B"] }, { repos: [1] }, { repos: ["a/b"], privateOk: "yes" }]) {
      expect(checkedReferences(bad)).toBeUndefined();
    }
  });
});

describe("the locked copy in a sandboxed step", { timeout: 30_000 }, () => {
  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") || root)("refuses chmod, write, delete and commit", async () => {
    const { sandboxProfile, stepSandboxPaths } = await import("../src/engine/os-sandbox.js");
    await prepare(summary({ repos: ["acme/lib"] }));
    const dir = join(runDir, "reference", "acme-lib");
    const learnings = join(tmp, `learn-${n}`, "l.md");
    mkdirSync(join(tmp, `learn-${n}`), { recursive: true });
    const profile = sandboxProfile(stepSandboxPaths({ runDir, learnings }));
    const inBox = (script: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { cwd: dir, stdio: "pipe", encoding: "utf8" });
    expect(inBox("cat ROUTES.md").stdout).toBe("GET /v1/items\n");
    for (const script of ["chmod u+w ROUTES.md", "chmod u+w .", "echo x > ROUTES.md", "rm -f ROUTES.md", "git -c user.email=t@t -c user.name=t commit --allow-empty -qm x"]) {
      expect(inBox(script).status, script).not.toBe(0);
    }
    expect(readFileSync(join(dir, "ROUTES.md"), "utf8")).toBe("GET /v1/items\n");
    chmodSync(dir, 0o555);
  });
});
