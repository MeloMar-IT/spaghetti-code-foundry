import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { readSkillLock } from "../src/skills/lock.js";
import { discoverSkills } from "../src/skills/registry.js";
import { skillsCommand } from "../src/skills/cli.js";

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
const digestOf = (key: string) => discoverSkills(ConfigSchema.parse({}).skills, { home, builtinRoot: builtin, userHome: join(base, "u"), env: {} }).byKey.get(key)!.digest;

async function sk(positionals: string[], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { home, builtinRoot: builtin, userHome: join(base, "u"), env: {}, skills: ConfigSchema.parse({}).skills });
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
    const port = 20000 + Math.floor(Math.random() * 20000);
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
