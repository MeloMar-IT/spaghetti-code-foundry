import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { readSkillLock } from "../src/skills/lock.js";
import { discoverSkills } from "../src/skills/registry.js";
import { skillsCommand } from "../src/skills/cli.js";
import { releaseDigest, type ReleaseManifest } from "../src/skills/release.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { readSources } from "../src/skills/sources.js";
import { freePort } from "./helpers/port.js";

const CLI = resolve("dist/cli.js");
let base: string;
let home: string;
let builtin: string;
let saved: string | undefined;
beforeEach(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing — run `npm run build` first");
  saved = process.env.FACTORY_HOME;
  base = realpathSync(mkdtempSync(join(tmpdir(), "skillcli-")));
  home = join(base, "home");
  builtin = join(base, "builtin");
  mkdirSync(home);
  mkdirSync(builtin);
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(base, { recursive: true, force: true });
});

const lockFile = () => join(home, "skills.lock.json");
const D = "sha256:" + "0".repeat(64);

function pkg(root: string, id: string, version = "1.0.0"): string {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: ${version}\n`);
  return d;
}
const tamper = (dir: string) => {
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "references", "x.md"), "changed");
};
const dev = () => ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
const digestOf = (key: string) => discoverSkills(dev(), { home, builtinRoot: builtin, userHome: join(base, "u"), env: {} }).byKey.get(key)!.digest;

async function sk(positionals: string[], values: Record<string, unknown> = {}, skills = dev()) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { home, builtinRoot: builtin, userHome: join(base, "u"), env: {}, skills });
  return { code, out: lines.join("\n") };
}

describe("skillsCommand", () => {
  it("lists with trust, pin and digest, and creates no lock file", async () => {
    pkg(builtin, "small-changes");
    const r = await sk([]);
    expect(r.out).toContain("builtin unpinned sha256:");
    expect(r.code).toBe(0);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("shows the provider name next to a vendor-specific skill only", async () => {
    const d = pkg(builtin, "vendor-skill");
    writeFileSync(join(d, "skill.yaml"), "id: vendor-skill\nversion: 1.0.0\nprovider:\n  name: acme\n");
    pkg(builtin, "portable-skill");
    const lines = (await sk([])).out.split("\n");
    expect(lines.find((l) => l.startsWith("vendor-skill"))).toContain(" provider acme");
    expect(lines.find((l) => l.startsWith("portable-skill"))).not.toContain("provider");
  });

  it("pin --builtin pins, and the list shows it", async () => {
    pkg(builtin, "small-changes");
    expect((await sk(["pin"], { builtin: true })).out).toBe("Pinned small-changes@1.0.0");
    expect((await sk([])).out).toContain("builtin pinned");
    expect((await sk(["pin"], { builtin: true })).out).toBe("Nothing to pin");
  });

  it("pins with the listed digest, again, and refuses another digest", async () => {
    pkg(join(home, "skills"), "a");
    const d = digestOf("a@1.0.0");
    expect(await sk(["pin", "a@1.0.0", d])).toEqual({ code: 0, out: "Pinned a@1.0.0" });
    expect(await sk(["pin", "a@1.0.0", d])).toEqual({ code: 0, out: "Already pinned a@1.0.0" });
    await expect(sk(["pin", "a@1.0.0", D])).rejects.toThrow();
  });

  it("shows both digests after tampering and pin --replace clears it", async () => {
    const dir = pkg(join(home, "skills"), "a");
    const old = digestOf("a@1.0.0");
    await sk(["pin", "a@1.0.0", old]);
    tamper(dir);
    const now = digestOf("a@1.0.0");
    const r = await sk([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(old);
    expect(r.out).toContain(now);
    await expect(sk(["pin", "a@1.0.0", now])).rejects.toThrow("--replace");
    expect((await sk(["pin", "a@1.0.0", now], { replace: true })).out).toBe("Replaced the pin of a@1.0.0");
    expect((await sk([])).code).toBe(0);
  });

  it("unpin succeeds once", async () => {
    pkg(join(home, "skills"), "a");
    await sk(["pin", "a@1.0.0", digestOf("a@1.0.0")]);
    expect(await sk(["unpin", "a@1.0.0"])).toEqual({ code: 0, out: "Unpinned a@1.0.0" });
    expect(await sk(["unpin", "a@1.0.0"])).toEqual({ code: 1, out: "a@1.0.0 is not pinned" });
  });

  it("names the lock file when it is corrupt", async () => {
    pkg(builtin, "small-changes");
    writeFileSync(lockFile(), "{");
    const r = await sk([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`PROBLEM skill lock ${lockFile()}:`);
  });

  it("pin --builtin reports a changed built-in skill, exits 1 and keeps the lock", async () => {
    const dir = pkg(builtin, "small-changes");
    await sk(["pin"], { builtin: true });
    const before = readFileSync(lockFile());
    tamper(dir);
    const r = await sk(["pin"], { builtin: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("small-changes@1.0.0");
    expect(r.out).toContain("--replace");
    expect(r.out).not.toContain("Nothing to pin");
    expect(readFileSync(lockFile())).toEqual(before);
  });

  it("connectors lists the connectors and touches nothing", async () => {
    const r = await sk(["connectors"]);
    const lines = r.out.split("\n");
    expect(r.code).toBe(0);
    expect(lines[0]).toMatch(/^awesome-copilot\s+github\.com\/github\/awesome-copilot skills agent-skills community MIT track main$/);
    expect(lines[1]).toMatch(/^anthropic-skills\s+github\.com\/anthropics\/skills skills agent-skills verified Apache-2\.0 track main$/);
    expect(lines[2]).toMatch(/^vercel-agent-skills\s+github\.com\/vercel-labs\/agent-skills skills,agent-skills agent-skills verified MIT track main$/);
    expect(lines.at(-1)).toBe("OK 3 connectors");
    expect(existsSync(lockFile())).toBe(false);
  });

  const refused: [string, string[], Record<string, unknown>][] = [
    ["unpin with --replace", ["unpin", "x@1.0.0"], { replace: true }],
    ["list with --builtin", [], { builtin: true }],
    ["pin with --admin", ["pin", "x@1.0.0", D], { admin: true }],
    ["pin --builtin --replace", ["pin"], { builtin: true, replace: true }],
    ["pin --builtin with operands", ["pin", "x@1.0.0"], { builtin: true }],
    ["pin without a digest", ["pin", "x@1.0.0"], {}],
    ["unpin without a key", ["unpin"], {}],
    ["unpin garbage", ["unpin", "garbage"], {}],
    ["pin garbage", ["pin", "garbage", D], {}],
    ["pin a bad digest", ["pin", "x@1.0.0", "sha256:zz"], {}],
    ["connectors with an operand", ["connectors", "x"], {}],
    ["connectors with an option", ["connectors"], { replace: true }],
    ["unknown sub-command", ["frobnicate"], {}],
  ];
  for (const [name, positionals, values] of refused) {
    it(`refuses ${name} and creates no lock file`, async () => {
      await expect(sk(positionals, values)).rejects.toThrow();
      expect(existsSync(lockFile())).toBe(false);
    });
  }

  it("checks the operand before it reads a corrupt lock", async () => {
    writeFileSync(lockFile(), "{");
    await expect(sk(["unpin", "garbage"])).rejects.toThrow("not a skill key");
  });

  describe("catalogue releases", () => {
    const strict = (approved: unknown[] = [], roots = [join(base, "rel")]) => ConfigSchema.parse({ skills: { roots, releases: { approved } } }).skills;
    const manifest = (root: string, over: Record<string, unknown> = {}): ReleaseManifest => {
      const m = {
        schema: 1,
        catalogue: "acme-skills",
        version: "1.0.0",
        createdAt: "2026-01-02T03:04:05Z",
        source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40) },
        skills: [{ id: "a", version: "1.0.0", digest: digestIn(root, "a@1.0.0") }],
        ...over,
      } as ReleaseManifest;
      writeFileSync(join(root, "catalogue-release.json"), JSON.stringify(m));
      return m;
    };
    const digestIn = (root: string, key: string) =>
      discoverSkills(ConfigSchema.parse({ skills: { roots: [root], releases: { allow_unreleased: true } } }).skills, { home, builtinRoot: builtin, userHome: join(base, "u"), env: {} }).byKey.get(key)!.digest;

    it("prints the RELEASE line of an approved release and exits 0", async () => {
      const root = join(base, "rel");
      pkg(root, "a");
      const m = manifest(root);
      const digest = releaseDigest(m);
      const r = await sk([], {}, strict([{ catalogue: m.catalogue, version: m.version, digest }]));
      expect(r.out).toContain(`RELEASE skills.roots[0] acme-skills@1.0.0 ${digest} approved`);
      expect(r.out).not.toContain("NOTE");
      // the release loads from skills.roots, but it is not in the store: scf skills says to adopt it
      expect(r.out).toContain("scf skills release adopt acme-skills@1.0.0");
      expect(r.code).toBe(1);
    });

    it("prints the digest of an unapproved release and exits 1", async () => {
      const root = join(base, "rel");
      pkg(root, "a");
      const m = manifest(root);
      const r = await sk([], {}, strict());
      expect(r.out).toContain(`RELEASE skills.roots[0] acme-skills@1.0.0 ${releaseDigest(m)} unapproved`);
      expect(r.out).toContain("is not in skills.releases.approved");
      expect(r.code).toBe(1);
    });

    it("says so in a NOTE line when a folder without a manifest is loaded in development", async () => {
      const root = join(base, "rel");
      pkg(root, "a");
      const dev2 = ConfigSchema.parse({ skills: { roots: [root], releases: { allow_unreleased: true } } }).skills;
      const r = await sk([], {}, dev2);
      expect(r.out).toContain("NOTE skills.roots[0] is loaded without an approved release");
      expect(r.out).toContain("allow_unreleased");
      expect(r.code).toBe(0);
    });

    it("prints no RELEASE line and no value for a manifest that looks like a credential", async () => {
      const root = join(base, "rel");
      pkg(root, "a");
      const key = "sk-ant-" + "a".repeat(20);
      manifest(root, { catalogue: key });
      const r = await sk([], {}, strict());
      expect(r.out).not.toContain("RELEASE");
      expect(r.out).not.toContain(key);
      expect(r.code).toBe(1);
    });
  });
});

describe("scf skills (spawned)", () => {
  const env = () => ({ ...process.env, FACTORY_HOME: home });
  const scf = (...args: string[]) => spawnSync(process.execPath, [CLI, "skills", ...args], { encoding: "utf8", env: env() });

  it("forwards the options: pin --builtin works and unpin --replace is refused", () => {
    expect(scf("pin", "--builtin").status).toBe(0);
    expect(readFileSync(lockFile(), "utf8")).toContain("small-changes@");
    const r = scf("unpin", "x@1.0.0", "--replace");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--replace");
  });

  it("four pins at once all succeed and the same key is pinned once", async () => {
    const root = join(home, "skills");
    writeFileSync(join(home, "config.yaml"), "skills:\n  releases:\n    allow_unreleased: true\n");
    for (const id of ["a", "b", "c"]) pkg(root, id);
    const run = (key: string) =>
      new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(process.execPath, [CLI, "skills", "pin", key, digestOf(key)], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.resume();
        child.on("close", (code) => done({ code, out }));
      });
    const results = await Promise.all([run("a@1.0.0"), run("a@1.0.0"), run("b@1.0.0"), run("c@1.0.0")]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    const lock = readSkillLock(home);
    expect(lock.ok && Object.keys(lock.pins).sort()).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
    const same = results.slice(0, 2).map((r) => r.out.trim()).sort();
    expect(same).toEqual(["Already pinned a@1.0.0", "Pinned a@1.0.0"]);
  });

  /** Starts `scf serve`, waits for the banner (bounded), stops it and returns what it printed. */
  async function serveUntilBanner(): Promise<string> {
    const port = await freePort();
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--repo", repo], {
      env: { ...env(), FACTORY_NO_SUPERVISE: "1", FACTORY_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.resume();
    try {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 20_000);
        const check = setInterval(() => {
          if (out.includes("Ctrl+C to stop")) {
            clearTimeout(timer);
            clearInterval(check);
            done();
          }
        }, 25);
        child.on("close", () => {
          clearTimeout(timer);
          clearInterval(check);
          done();
        });
      });
      return out;
    } finally {
      child.kill();
    }
  }

  it("scf serve with a clean data folder pins, then reaches the banner", async () => {
    const out = await serveUntilBanner();
    expect(out.indexOf("pinned the built-in skills:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Ctrl+C to stop")).toBeGreaterThan(out.indexOf("pinned the built-in skills:"));
    expect(readFileSync(lockFile(), "utf8")).toContain("small-changes@");
  });

  it("scf serve with a corrupt lock warns, still starts and keeps the file", async () => {
    writeFileSync(lockFile(), "{");
    const out = await serveUntilBanner();
    const warn = out.indexOf("warning: the built-in skills were not pinned");
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Ctrl+C to stop")).toBeGreaterThan(warn);
    expect(readFileSync(lockFile(), "utf8")).toBe("{");
  });

  it("scf serve pins the built-in skills before it listens", async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", ok));
    const port = (blocker.address() as { port: number }).port;
    const repo = join(base, "repo");
    mkdirSync(repo);
    try {
      const r = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--repo", repo], {
          env: { ...env(), FACTORY_NO_SUPERVISE: "1", FACTORY_NO_OPEN: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => done({ code, out, err }));
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain("EADDRINUSE");
      expect(r.out).toContain("pinned the built-in skills:");
      expect(r.out).not.toContain("Ctrl+C to stop");
      expect(readFileSync(lockFile(), "utf8")).toContain("small-changes@");
    } finally {
      blocker.close();
    }
  });
});

describe("skillsCommand overrides check and project-pins check", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");
  const entry = (extra: string) => `    capability: cap
    target: a@1.0.0
    by: "@octocat"
    reason: Reviewed
    from: "2026-01-01T00:00:00Z"
${extra}`;
  const files = {
    overrides: (extra: string) => `schema: 1\noverrides:\n  -\n${entry(extra)}    scope: all\n`,
    "project-pins": (extra: string) => `schema: 1\npins:\n  -\n${entry(extra)}`,
  };
  async function check(kind: "overrides" | "project-pins", text: string | undefined) {
    const file = join(base, "choices.yaml");
    if (text !== undefined) writeFileSync(file, text);
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: [kind, "check", file], values: {} }, (l) => lines.push(l), { now: NOW });
    return { code, out: lines.join("\n") };
  }
  for (const kind of ["overrides", "project-pins"] as const) {
    it(`${kind}: lists a valid file with the digest`, async () => {
      const r = await check(kind, files[kind](`    expires: "2027-01-01T00:00:00Z"\n`));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/cap a@1\.0\.0 @octocat .* sha256:[0-9a-f]{64}\nOK 1 entries$/);
    });
    it(`${kind}: fails on an invalid, an expired and a missing file`, async () => {
      const invalid = await check(kind, "schema: 2\n");
      expect(invalid.code).toBe(1);
      expect(invalid.out).toContain("PROBLEM");
      const expired = await check(kind, files[kind](`    expires: "2026-03-01T00:00:00Z"\n`));
      expect(expired.code).toBe(1);
      expect(expired.out).toContain(" EXPIRED");
      const due = await check(kind, files[kind](`    review_by: "2026-03-01T00:00:00Z"\n`));
      expect(due.code).toBe(0);
      expect(due.out).toContain(" REVIEW DUE");
      rmSync(join(base, "choices.yaml"));
      expect((await check(kind, undefined)).code).toBe(1);
    });
    it(`${kind}: an unknown option or operand is a syntax error`, async () => {
      await expect(skillsCommand({ positionals: [kind, "check"], values: { repo: "x" } }, () => {}, {})).rejects.toThrow("unexpected option");
      await expect(skillsCommand({ positionals: [kind, "list"], values: {} }, () => {}, {})).rejects.toThrow('expects "check"');
    });
  }
});

describe("skillsCommand selections check", () => {
  const DIGEST = "sha256:" + "a".repeat(64);
  const entry = (skill: string, sdkVersion = '">=4.7"') =>
    [
      "  - source: microsoft-skills",
      `    skill: ${skill}`,
      `    digest: ${DIGEST}`,
      "    scope: provider",
      "    provider: azure",
      '    product: { name: azure-cosmos-db, version: "2024-11" }',
      `    sdk: { name: azure-cosmos, language: python, version: ${sdkVersion} }`,
      "    category: database",
      "    capabilities: [cosmos-db]",
      "    requires: { clis: [az], mcp: [azure], credentials: [azure-identity], services: [azure-cosmos-db] }",
      '    owner: "@octocat"',
      "    reviewed: 2026-10-13",
      "",
    ].join("\n");
  const doc = (...entries: string[]) => `schema: 1\nselections:\n${entries.join("")}`;
  async function run(positionals: string[], values: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["selections", ...positionals], values }, (l) => lines.push(l), { cwd: base, today: "2026-10-13" });
    return { code, lines };
  }
  it("lists a valid file, one line per entry, then OK", async () => {
    writeFileSync(join(base, "sel.yaml"), doc(entry("azure-cosmos-py"), entry("azure-blob-py")));
    const r = await run(["check", "sel.yaml"]);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toContain("microsoft-skills/azure-cosmos-py");
    expect(r.lines[0]).toContain("provider azure");
    expect(r.lines[0]).toContain("cli-az,credential-azure-identity,mcp-azure,service-azure-cosmos-db");
    expect(r.lines[2]).toBe("OK 2 selections");
  });
  it("uses skill-selections.yaml in the folder by default", async () => {
    writeFileSync(join(base, "skill-selections.yaml"), doc(entry("azure-cosmos-py")));
    expect((await run(["check"])).lines.at(-1)).toBe("OK 1 selections");
  });
  it("fails on a missing file", async () => {
    const r = await run(["check", "nope.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM the skill selection file does not exist"]);
  });
  it("fails on an invalid file with PROBLEM lines and no OK", async () => {
    writeFileSync(join(base, "bad.yaml"), doc(entry("azure-cosmos-py", "4.7")));
    const r = await run(["check", "bad.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => /^PROBLEM selections\[0\] \(.+\) sdk\.version: /.test(l))).toBe(true);
    expect(r.lines.join("\n")).not.toContain("OK");
  });
  it("rejects a bad command line", async () => {
    await expect(run([])).rejects.toThrow('expects "check"');
    await expect(run(["check", "a", "b"])).rejects.toThrow('expects "check"');
    await expect(run(["check"], { repo: "x" })).rejects.toThrow("unexpected option");
  });
});

describe("skillsCommand overlap syntax", () => {
  it("checks the operands and options before it reads anything", async () => {
    const run = (positionals: string[], values: Record<string, unknown> = {}) => skillsCommand({ positionals, values }, () => undefined, { home, builtinRoot: builtin, skills: dev() });
    await expect(run(["overlap"])).rejects.toThrow("expects one source id");
    await expect(run(["overlap", "a", "b"])).rejects.toThrow("expects one source id");
    await expect(run(["overlap", "Bad_Id"])).rejects.toThrow("must be a source id");
    await expect(run(["overlap", "lib"], { repo: "x" })).rejects.toThrow("unexpected option");
  });
});

describe("scf skills review", () => {
  const COMMIT = "a".repeat(40);
  const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
  const md = (name: string, desc = `A skill called ${name}.`) => `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody.\n`;
  let cwd: string;
  const sourcesYaml = [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", "    status: enabled",
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community",
    "    licence: {allow: [MIT]}", "    update: {cadence: weekly}", "    owner: '@octocat'",
    `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
  ].join("\n");
  function tree(files: Record<string, string>): SourceTree {
    const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
    return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
  }
  function setup() {
    cwd = join(base, "cwd");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml);
  }
  function stage(files: Record<string, string>) {
    setup();
    const r = readSources(join(cwd, "skill-sources.yaml"));
    if (r.state !== "ok") throw new Error("bad sources");
    const t = tree(files);
    const prep = prepareImport(r.manifest.sources[0]!, t);
    const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
    return publishImport(addLicenceEvidence(prep, licence, "2026-10-01T10:00:00Z"), { home });
  }
  async function review(operands: string[] = ["lib"], values: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["review", ...operands], values }, (l) => lines.push(l), { home, cwd, builtinRoot: builtin, userHome: join(base, "u"), env: {}, skills: dev() });
    return { code, lines, out: lines.join("\n") };
  }
  const snap = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      const st = statSync(p);
      return e.isDirectory() ? [`${p} ${st.mode}`, ...snap(p)] : [`${p} ${st.mode} ${readFileSync(p).toString("hex")}`];
    });

  it("prints the report of a clean import and exits 0", async () => {
    pkg(builtin, "small-changes");
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const r = await review();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^REVIEW lib github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64} trust=community/);
    expect(r.out).toMatch(/SKILL \S+ skills\/demo name=demo .* trust=community not-promoted/);
    expect(r.out).toMatch(/LICENCE \S+: allowed MIT/);
    expect(r.out).toContain("ATTRIBUTION");
    expect(r.out).toContain("REVIEWED 1 skill from");
    expect(r.out).toContain("nothing was promoted");
  });

  it("reports an upstream skill named like a built-in, even with other content", async () => {
    pkg(builtin, "java");
    stage({ "skills/java/SKILL.md": md("java", "Something else about java."), LICENSE: MIT });
    const r = await review();
    expect(r.out).toContain("NAME ");
    expect(r.out).toContain("same name as existing java@1.0.0 (built-in)");
    expect(r.out).toMatch(/COLLISION col-[0-9a-f]+ fork fork\.same-name blocking=no/);
    expect(r.code).toBe(0);
  });

  it("exits 1 when the licence is missing", async () => {
    stage({ "skills/demo/SKILL.md": md("demo") });
    const r = await review();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/LICENCE \S+: missing/);
  });

  it("prints Markdown with --markdown", async () => {
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const r = await review(["lib"], { markdown: true });
    expect(r.lines[0]).toMatch(/^## Skill import review/);
    expect(r.code).toBe(0);
  });

  it("prints a failed read as Markdown too", async () => {
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const r = await review(["other"], { markdown: true });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^## Skill import review/);
    expect(r.out).toContain("### Problems");
  });

  it("writes nothing and gives the same bytes twice", async () => {
    pkg(builtin, "small-changes");
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const before = [...snap(home), ...snap(cwd), ...snap(builtin)];
    const a = await review();
    const b = await review();
    expect(b.out).toBe(a.out);
    expect([...snap(home), ...snap(cwd), ...snap(builtin)]).toEqual(before);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("prints one PROBLEM and exits 1 without a source file, an unknown source or a staged import", async () => {
    mkdirSync(join(base, "cwd"), { recursive: true });
    cwd = join(base, "cwd");
    expect((await review()).out).toContain("PROBLEM the skill source file does not exist");
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const unknown = await review(["nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("PROBLEM unknown source");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
    const none = await review();
    expect(none.code).toBe(1);
    expect(none.out).toContain('run "scf skills import lib" first');
  });

  it("refuses a tampered staged import", async () => {
    stage({ "skills/demo/SKILL.md": md("demo"), LICENSE: MIT });
    const found = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? found(join(d, e.name)) : e.name === "SKILL.md" ? [join(d, e.name)] : []));
    const file = found(home).find((f) => f.includes("demo"))!;
    writeFileSync(file, md("demo") + "x");
    const r = await review();
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.out).toContain("nothing was reviewed");
  });

  it("checks its syntax first", async () => {
    setup();
    await expect(review([])).rejects.toThrow("expects one source id");
    await expect(review(["lib", "x"])).rejects.toThrow("expects one source id");
    await expect(review(["lib"], { replace: true })).rejects.toThrow("unexpected option --replace");
    await expect(review(["Not A Slug"])).rejects.toThrow("must be a source id");
  });
});

describe("skillsCommand profiles check", () => {
  // Samples are built from pieces so that tools/secret-scan finds nothing in this file.
  const AT = "@";
  const URL_USER_PW = "https://user:pw" + AT + "example.com";
  const SKILLS = [
    "schema: 1",
    "exclusive: [pdf-write]",
    "sources:",
    "  - id: example-skills",
    "    skills:",
    "      - name: pdf-reader",
    "        class: portable",
    "        capabilities: [pdf-read, pdf-write]",
    "        high_risk: [pdf-write]",
    "        requires: { config: [DATABASE_URL], tools: [shell] }",
    "      - name: sheet-reader",
    "        class: vendor",
    "        capabilities: [sheet-read]",
    "",
  ].join("\n");
  async function run(positionals: string[], values: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["profiles", ...positionals], values }, (l) => lines.push(l), { cwd: base });
    return { code, lines };
  }
  it("prints one line per skill, then OK", async () => {
    writeFileSync(join(base, "p.yaml"), SKILLS);
    const r = await run(["check", "p.yaml"]);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toContain("example-skills/pdf-reader");
    expect(r.lines[0]).toContain("high_risk=pdf-write config=DATABASE_URL tools=shell connectors=- live_services=- evaluations=-");
    expect(r.lines[2]).toBe("OK 2 skills in 1 sources, 1 exclusive");
  });
  it("prints only the summary for an empty catalogue", async () => {
    writeFileSync(join(base, "skill-source-profiles.yaml"), "schema: 1\nsources: []\n");
    const r = await run(["check"]);
    expect(r).toEqual({ code: 0, lines: ["OK 0 skills in 0 sources, 0 exclusive"] });
  });
  it("prints PROBLEM lines for an invalid file", async () => {
    writeFileSync(join(base, "p.yaml"), SKILLS.replace("class: portable", "class: official"));
    const r = await run(["check", "p.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM sources[0] (example-skills) skills[0] (pdf-reader) class: must be one of portable, vendor"]);
  });
  it("fails on a missing file", async () => {
    const r = await run(["check"]);
    expect(r).toEqual({ code: 1, lines: ["PROBLEM the source profile file does not exist"] });
  });
  it("rejects bad syntax", async () => {
    await expect(run([])).rejects.toThrow("usage:");
    await expect(run(["list"])).rejects.toThrow("usage:");
    await expect(run(["check", "a", "b"])).rejects.toThrow("usage:");
    await expect(run(["check"], { replace: true })).rejects.toThrow("usage:");
  });
  it("does not touch the data folder", async () => {
    writeFileSync(join(base, "p.yaml"), SKILLS);
    await run(["check", "p.yaml"]);
    expect(readdirSync(home)).toEqual([]);
  });
  it("prints nothing unsafe for a hostile file", async () => {
    const doc = [
      "schema: 1",
      "sources:",
      "  - id: a",
      "    skills:",
      "      - name: b",
      "        class: vendor",
      "        capabilities: [c]",
      `        requires: { tools: ["${URL_USER_PW}"] }`,
      `        "${URL_USER_PW}": 1`,
      "",
    ].join("\n");
    writeFileSync(join(base, "p.yaml"), doc);
    const r = await run(["check", "p.yaml"]);
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(2);
    const out = r.lines.join("\n");
    expect(out).not.toContain(URL_USER_PW);
    expect(out).not.toContain("user" + AT);
    expect(out).not.toContain("pw" + AT);
  });
  it("leaves `sources check` unchanged when there is no profile file", async () => {
    writeFileSync(
      join(base, "skill-sources.yaml"),
      [
        "schema: 1",
        "sources:",
        "  - id: example-skills",
        "    repository: https://github.com/example/skills",
        "    status: enabled",
        "    ref: { track: main, approved: '0123456789abcdef0123456789abcdef01234567' }",
        "    paths: [skills]",
        "    adapter: agent-skills",
        "    trust: community",
        "    licence: { allow: [MIT] }",
        "    update: { cadence: weekly }",
        "    owner: '@octocat'",
        "    review: { by: '@octocat', on: '2026-01-01', commit: '0123456789abcdef0123456789abcdef01234567', licence: MIT }",
        "",
      ].join("\n"),
    );
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["sources", "check"], values: {} }, (l) => lines.push(l), { cwd: base, today: "2026-10-13" });
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("OK 1 sources, 1 enabled");
  });
});
